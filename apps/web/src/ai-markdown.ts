import { calloutFromAside } from "./notion-import";
import { toEmbed } from "./link-embeds";

/**
 * AI 편집용 블록 ⇄ 마크다운 변환.
 * LLM 에는 일반 마크다운 + 몇 가지 Noty 규칙(AI_EDIT_RULES)만 보여 주고,
 * 마크다운으로 나타낼 수 없는 블록(페이지·컬렉션·캔버스·다단·파일 등)은 <<block:N>> 자리표시로 보낸 뒤 원래 블록으로 되돌린다.
 */

type Block = { id?: string; type: string; props?: Record<string, any>; content?: any; children?: Block[] };
type ToMarkdown = (blocks: Block[]) => string;
type ParseMarkdown = (markdown: string) => Block[];

/** 일반 마크다운 변환기에 그대로 맡기는 블록 */
const PLAIN_TYPES = new Set(["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "codeBlock", "table", "image", "divider"]);
const CALLOUT_EMOJI: Record<string, string> = { note: "📝", info: "💡", tip: "✅", warning: "⚠️", danger: "🚨", idea: "✨" };

function isPlain(block: Block): boolean {
  if (!PLAIN_TYPES.has(block.type) || block.props?.isToggleable) return false;
  return (block.children ?? []).every(isPlain);
}

function plainText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : plainText(part?.content))).join("");
}

export interface AIMarkdownSnapshot {
  markdown: string;
  /** 자리표시 번호 → 원래 블록 */
  originals: Map<string, Block>;
}

export function blocksToAIMarkdown(blocks: Block[], toMarkdown: ToMarkdown): AIMarkdownSnapshot {
  const originals = new Map<string, Block>();
  const parts: string[] = [];
  let placeholders = 0;
  let run: Block[] = [];
  const flush = () => {
    if (run.length) parts.push(toMarkdown(run).trim());
    run = [];
  };
  for (const block of blocks) {
    if (isPlain(block)) {
      run.push(block);
      continue;
    }
    flush();
    if (block.type === "callout" && !block.children?.length) {
      const text = toMarkdown([{ type: "paragraph", content: block.content }]).trim().replace(/\n/g, "\n> ");
      parts.push(`> ${CALLOUT_EMOJI[block.props?.variant] ?? "💡"} ${text}`);
    } else if (block.type === "toc") {
      parts.push("[목차]");
    } else if ((block.type === "bookmark" || block.type === "embed") && block.props?.url) {
      originals.set(`url:${block.props.url}`, block);
      parts.push(block.props.url);
    } else if (block.type === "mathBlock") {
      parts.push(`$$\n${plainText(block.content)}\n$$`);
    } else if (block.type === "diagram") {
      parts.push("```mermaid\n" + plainText(block.content) + "\n```");
    } else {
      const key = String(++placeholders);
      originals.set(key, block);
      parts.push(`<<block:${key}>>`);
    }
  }
  flush();
  return { markdown: parts.filter(Boolean).join("\n\n"), originals };
}

/** 모델이 덧붙이는 생각 태그·설명(<result> 밖)·전체를 감싼 ```markdown 울타리를 걷어 낸다 */
export function cleanAIMarkdown(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // 스트리밍 중이라 닫는 태그가 아직 없어도 꺼낸다
  const tagged = text.match(/<result>\s*([\s\S]*?)\s*(?:<\/result>|$)/i);
  if (tagged) text = tagged[1].trim();
  const fenced = text.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

/**
 * AI 가 돌려준 마크다운 → 블록. 자리표시는 원래 블록으로, Noty 규칙 줄은 전용 블록으로 바꾼다.
 * 모델이 지운 자리표시 블록은 끝에 다시 붙여 잃어버리지 않게 한다.
 */
export function aiMarkdownToBlocks(raw: string, parse: ParseMarkdown, originals: Map<string, Block> = new Map()): Block[] {
  const lines = cleanAIMarkdown(raw).split("\n");
  const used = new Set<string>();
  const out: Block[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const markdown = buffer.join("\n").trim();
    buffer = [];
    if (markdown) out.push(...parse(markdown));
  };
  const push = (block: Block) => {
    flush();
    out.push(block);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = trimmed.match(/^```\s*(\S*)/);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && l.trim().startsWith("```"));
      const close = end < 0 ? lines.length : end;
      if (fence[1].toLowerCase() === "mermaid") push({ type: "diagram", content: lines.slice(i + 1, close).join("\n") });
      else buffer.push(...lines.slice(i, close + 1));
      i = close;
      continue;
    }

    const inlineMath = trimmed.match(/^\$\$(.+)\$\$$/);
    if (inlineMath) {
      push({ type: "mathBlock", content: inlineMath[1].trim() });
      continue;
    }
    if (trimmed === "$$") {
      const end = lines.findIndex((l, j) => j > i && l.trim() === "$$");
      const close = end < 0 ? lines.length : end;
      push({ type: "mathBlock", content: lines.slice(i + 1, close).join("\n").trim() });
      i = close;
      continue;
    }

    const placeholder = trimmed.match(/^<<\s*block:(\d+)\s*>>$/);
    if (placeholder) {
      const original = originals.get(placeholder[1]);
      if (original && !used.has(placeholder[1])) {
        used.add(placeholder[1]);
        push(original);
      }
      continue;
    }

    if (/^\[(목차|TOC)\]$/i.test(trimmed)) {
      push({ type: "toc" });
      continue;
    }

    if (/^https?:\/\/\S+$/.test(trimmed)) {
      const key = `url:${trimmed}`;
      const original = originals.get(key);
      if (original) used.add(key);
      push(original ?? { type: toEmbed(trimmed) ? "embed" : "bookmark", props: { url: trimmed } });
      continue;
    }

    const callout = trimmed.match(/^>\s*(\p{Extended_Pictographic}️?)\s*(.*)$/u);
    if (callout) {
      const textLines = [callout[2]];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1].trim())) textLines.push(lines[++i].trim().replace(/^>\s?/, ""));
      const { variant, text } = calloutFromAside(`${callout[1]} ${textLines.join("\n").trim()}`);
      push({ type: "callout", props: { variant }, content: parse(text)[0]?.content ?? text });
      continue;
    }

    buffer.push(line);
  }
  flush();

  for (const [key, block] of originals) if (!used.has(key) && !key.startsWith("url:")) out.push(block);
  return out;
}

/* ------------------------------------------------------------------ 편집기 연결 (AI 패널 ↔ 현재 페이지) */

export interface AIEditSelection {
  pageId: string;
  blockIds: string[];
  markdown: string;
  originals: Map<string, Block>;
}

export type AIReplaceResult = "ok" | "missing" | "changed";

/** 현재 페이지 편집기를 AI 패널에 열어 주는 창구. 모두 편집기 API 로 바꾸므로 협업·저장·⌘Z 가 그대로 이어진다. */
export interface AIEditorBridge {
  pageId: string;
  selectionCount(): number;
  subscribe(callback: () => void): () => void;
  getSelection(): AIEditSelection | null;
  /** afterBlockId 뒤(없으면 커서 블록 뒤, 그것도 없으면 문서 끝)에 넣는다 */
  insert(markdown: string, afterBlockId?: string): boolean;
  replace(selection: AIEditSelection, markdown: string): AIReplaceResult;
}

export function createAIEditorBridge(editor: any, pageId: string): AIEditorBridge {
  const toMarkdown = (blocks: Block[]) => editor.blocksToMarkdownLossy(blocks);
  const parse = (markdown: string) => editor.tryParseMarkdownToBlocks(markdown);
  const selectedBlocks = (): Block[] => editor.getSelection()?.blocks ?? [];
  return {
    pageId,
    selectionCount: () => selectedBlocks().length,
    subscribe: (callback) => editor.onSelectionChange(callback),
    getSelection() {
      const blocks = selectedBlocks();
      if (!blocks.length) return null;
      return { pageId, blockIds: blocks.map((b) => b.id!), ...blocksToAIMarkdown(blocks, toMarkdown) };
    },
    insert(markdown, afterBlockId) {
      const blocks = aiMarkdownToBlocks(markdown, parse);
      const doc = editor.document;
      if (!blocks.length || !doc.length) return false;
      let anchor = afterBlockId ? editor.getBlock(afterBlockId) : undefined;
      if (!anchor) {
        try {
          anchor = editor.getTextCursorPosition().block;
        } catch {
          anchor = doc[doc.length - 1];
        }
      }
      editor.insertBlocks(blocks, anchor, "after");
      return true;
    },
    replace(selection, markdown) {
      const targets = selection.blockIds.map((id) => editor.getBlock(id));
      if (targets.some((b) => !b)) return "missing";
      // 요청한 뒤에 누군가(나 포함) 그 부분을 고쳤으면 덮어쓰지 않는다
      if (blocksToAIMarkdown(targets, toMarkdown).markdown !== selection.markdown) return "changed";
      const blocks = aiMarkdownToBlocks(markdown, parse, selection.originals);
      editor.transact(() => editor.replaceBlocks(targets, blocks.length ? blocks : [{ type: "paragraph" }]));
      return "ok";
    },
  };
}
