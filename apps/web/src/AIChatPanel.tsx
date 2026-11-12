import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { workspaceApi } from "./api";
import { WikiConceptView } from "./WikiConceptView";
import { WikiHome } from "./WikiHome";
import type { AIChatMessage, AIChatSource, AIProvider, AIStatus, PageDigest, WikiOverview } from "./vite-env";
import { cleanAIMarkdown, type AIEditorBridge, type AIEditSelection } from "./ai-markdown";

/** 화면용 메시지: 편집 모드로 받은 답은 바꿀 범위를 함께 들고 있다 */
type PanelMessage = AIChatMessage & { edit?: AIEditSelection; applied?: string };

const EDIT_ACTIONS: [label: string, prompt: string][] = [
  ["다듬기", "더 자연스럽게 다듬어 줘"],
  ["요약", "짧게 요약해 줘"],
  ["맞춤법", "맞춤법과 띄어쓰기를 고쳐 줘"],
  ["영어로", "영어로 번역해 줘"],
  ["할 일로", "할 일 목록으로 바꿔 줘"],
];

/* ==========================================================================
 * AI 어시스턴트 우측 사이드 패널
 * - 상단 바의 AI 버튼으로 열고 닫는다. (닫아도 대화 내용은 유지)
 * - 프로바이더(OpenAI / Claude / Ollama)는 Noty 설정(⌘,)에서 선택한다.
 * ========================================================================== */

export const AI_PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  ollama: "Ollama",
  gemini: "Gemini",
  custom: "OpenAI 호환",
};

export function AISparkleSvgIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M7 2.5l1.15 3.1a1.5 1.5 0 0 0 .9.9L12.15 7.65 9.05 8.8a1.5 1.5 0 0 0-.9.9L7 12.8 5.85 9.7a1.5 1.5 0 0 0-.9-.9L1.85 7.65l3.1-1.15a1.5 1.5 0 0 0 .9-.9L7 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M12.5 1.75v2.5M11.25 3h2.5M12.25 11.5v2.25M11.1 12.6h2.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function CloseSmallSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function NewChatSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 9.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V4.5A1.5 1.5 0 0 1 4.5 3H7"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path d="M11.5 2.5l2 2L8.25 9.75 6 10.25l.5-2.25L11.5 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function GearSmallSvgIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64L3.58 3.58"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** BlockNote 블록 배열을 AI에게 전달할 간단한 텍스트(마크다운 유사)로 변환 */
export function blocksToPlainText(blocks: readonly unknown[] | undefined, depth = 0): string {
  if (!Array.isArray(blocks)) return "";
  const lines: string[] = [];
  const inlineText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (Array.isArray(record.content)) return inlineText(record.content);
        return "";
      })
      .join("");
  };
  for (const value of blocks) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, any>;
    const indent = "  ".repeat(depth);
    let text = inlineText(block.content);
    if (block.type === "table" && Array.isArray(block.content?.rows)) {
      text = block.content.rows
        .map((row: any) => `| ${(row.cells ?? []).map((cell: any) => inlineText(cell?.content ?? cell)).join(" | ")} |`)
        .join("\n");
    }
    const trimmed = text.trim();
    if (trimmed) {
      let prefix = "";
      if (block.type === "heading") prefix = `${"#".repeat(Number(block.props?.level) || 1)} `;
      else if (block.type === "bulletListItem") prefix = "- ";
      else if (block.type === "numberedListItem") prefix = "1. ";
      else if (block.type === "checkListItem") prefix = block.props?.checked ? "- [x] " : "- [ ] ";
      else if (block.type === "quote") prefix = "> ";
      if (block.type === "codeBlock") lines.push(`${indent}\`\`\`\n${text}\n${indent}\`\`\``);
      else lines.push(`${indent}${prefix}${trimmed}`);
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      const childText = blocksToPlainText(block.children, depth + 1);
      if (childText) lines.push(childText);
    }
  }
  return lines.join("\n");
}

/** 본문의 [1], [2] 출처 번호를 누를 수 있는 링크로 바꾼다. */
function TextWithCitations({
  text,
  sources,
  onOpenSource,
}: {
  text: string;
  sources?: AIChatSource[];
  onOpenSource?: (source: AIChatSource) => void;
}) {
  if (!sources?.length || !onOpenSource) return <>{text}</>;
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  return (
    <>
      {text.split(/(\[\d+\])/g).map((part, index) => {
        const match = part.match(/^\[(\d+)\]$/);
        const source = match ? byNumber.get(Number(match[1])) : undefined;
        if (!source) return <Fragment key={index}>{part}</Fragment>;
        return (
          <button
            key={index}
            type="button"
            className="ai-panel__cite"
            title={source.context}
            onClick={() => onOpenSource(source)}
          >
            {source.n}
          </button>
        );
      })}
    </>
  );
}

/** 응답 텍스트의 ``` 코드 블록만 구분해서 보여주는 가벼운 렌더러 */
function MessageContent({
  content,
  sources,
  onOpenSource,
}: {
  content: string;
  sources?: AIChatSource[];
  onOpenSource?: (source: AIChatSource) => void;
}) {
  const parts = content.split(/```/);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const newline = part.indexOf("\n");
          const code = newline >= 0 ? part.slice(newline + 1) : part;
          return (
            <pre key={index} className="ai-panel__code">
              <code>{code.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        return part ? (
          <span key={index} className="ai-panel__text">
            <TextWithCitations text={part} sources={sources} onOpenSource={onOpenSource} />
          </span>
        ) : null;
      })}
    </>
  );
}

/** "제목 > 위치"에서 위치만 (없으면 빈 문자열) */
function sourceLocation(source: AIChatSource): string {
  const prefix = `${source.pageTitle || "제목 없는 문서"} > `;
  return source.context.startsWith(prefix) ? source.context.slice(prefix.length) : "";
}

function SourceList({ sources, onOpenSource }: { sources: AIChatSource[]; onOpenSource: (source: AIChatSource) => void }) {
  return (
    <div className="ai-panel__sources">
      <span className="ai-panel__sources-label">출처</span>
      {sources.map((source) => {
        const location = sourceLocation(source);
        return (
          <button
            key={source.n}
            type="button"
            className="ai-panel__source"
            title={source.context}
            onClick={() => onOpenSource(source)}
          >
            <span className="ai-panel__source-n">{source.n}</span>
            <span className="ai-panel__source-title">{source.pageTitle || "제목 없는 문서"}</span>
            {location && <span className="ai-panel__source-location">{location}</span>}
          </button>
        );
      })}
    </div>
  );
}

function DigestList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ai-digest__section">
      <div className="ai-digest__section-title">{title}</div>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

type PageConceptLink = { id: string; name: string; pageCount: number };

/** "이 페이지" 탭: 현재 페이지의 LLM 위키 정리 노트 */
function PageDigestView({
  pageTitle,
  digest,
  stale,
  concepts,
  onOpenConcept,
  onAsk,
}: {
  pageTitle?: string;
  digest: PageDigest;
  stale: boolean;
  concepts: PageConceptLink[];
  onOpenConcept: (conceptId: string) => void;
  onAsk: () => void;
}) {
  return (
    <div className="ai-digest ai-digest--expanded">
      <div className="ai-digest__header">
        <span className="ai-digest__title">{pageTitle || "제목 없는 문서"}</span>
        {stale && <span className="ai-digest__badge">내용이 바뀌어 곧 다시 정리됩니다</span>}
      </div>
      <p className="ai-digest__summary">{digest.summary}</p>
      <div className="ai-digest__body">
        <DigestList title="결정 사항" items={digest.decisions} />
        <DigestList title="할 일" items={digest.actionItems} />
        <DigestList title="핵심 내용" items={digest.keyPoints} />
        <DigestList title="열린 질문" items={digest.openQuestions} />
        {concepts.length > 0 && (
          <div className="ai-digest__section">
            <div className="ai-digest__section-title">주제 (누르면 위키 항목)</div>
            <div className="ai-digest__concepts">
              {concepts.map((concept) => (
                <button
                  key={concept.id}
                  type="button"
                  className={`ai-digest__concept ${concept.pageCount >= 2 ? "ai-digest__concept--shared" : ""}`}
                  title={concept.pageCount >= 2 ? `${concept.pageCount}개 페이지에서 언급 — 종합 보기` : "주제 보기"}
                  onClick={() => onOpenConcept(concept.id)}
                >
                  {concept.name}
                  {concept.pageCount >= 2 && <span>{concept.pageCount}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ai-digest__meta">
          AI 정리 · {digest.model} · {new Date(digest.generatedAt).toLocaleString()}
          {digest.truncated ? " · 문서가 길어 앞부분만 정리했습니다" : ""}
        </div>
        <button type="button" className="ds-btn ds-btn--outline ds-btn--md ai-digest__ask" onClick={onAsk}>
          이 페이지에 대해 질문하기
        </button>
      </div>
    </div>
  );
}

type AIPanelTab = "chat" | "page" | "wiki";

const WORKSPACE_PREF_KEY = "noty.ai.useWorkspace";

function readWorkspacePref(): boolean {
  try {
    return window.localStorage.getItem(WORKSPACE_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeWorkspacePref(value: boolean): void {
  try {
    window.localStorage.setItem(WORKSPACE_PREF_KEY, value ? "1" : "0");
  } catch {
    // 저장소를 쓸 수 없는 환경이면 무시 (기본값으로 동작)
  }
}

interface AIChatPanelProps {
  isOpen: boolean;
  /** 현재 보고 있는 페이지 (홈 화면이면 없음) — 정리본 표시용 */
  activePageId?: string;
  activePageTitle?: string;
  getActivePageContext: () => string;
  onClose: () => void;
  onOpenSettings: () => void;
  /** 설정 저장 후 상태를 다시 읽도록 증가시키는 값 */
  statusVersion: number;
  /** 출처를 눌렀을 때 해당 페이지(와 블록)를 연다 */
  onOpenSource: (pageId: string, blockId: string | null) => void;
  /** ⌘K 등 바깥에서 개념 보기를 요청 (nonce 가 바뀌면 다시 연다) */
  conceptRequest?: { id: string; nonce: number } | null;
  /** 현재 페이지 편집기 (읽기 전용·캔버스·홈이면 없음) */
  editorBridge?: AIEditorBridge | null;
}

export function AIChatPanel({
  isOpen,
  activePageId,
  activePageTitle,
  getActivePageContext,
  onClose,
  onOpenSettings,
  statusVersion,
  onOpenSource,
  conceptRequest,
  editorBridge = null,
}: AIChatPanelProps) {
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  // 편집기에서 고른 블록 수 (0 이면 일반 대화). ✕ 를 누르면 그 선택은 무시한다.
  const [selectionCount, setSelectionCount] = useState(0);
  const [ignoreSelection, setIgnoreSelection] = useState(false);
  useEffect(() => {
    if (!editorBridge) {
      setSelectionCount(0);
      return;
    }
    const update = () => {
      setSelectionCount(editorBridge.selectionCount());
      setIgnoreSelection(false);
    };
    update();
    return editorBridge.subscribe(update);
  }, [editorBridge]);
  const editing = selectionCount > 0 && !ignoreSelection;

  const setMessageAt = (index: number, patch: Partial<PanelMessage>) =>
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const applyMessage = (index: number, mode: "replace" | "insert") => {
    const message = messages[index];
    if (!editorBridge || !message) return;
    if (mode === "replace" && message.edit) {
      const result = editorBridge.replace(message.edit, message.content);
      if (result === "ok") setMessageAt(index, { applied: "바꿨습니다 · ⌘Z 로 되돌리기" });
      else setError(result === "missing" ? "선택했던 블록이 지워졌습니다. '아래에 넣기'를 쓰세요." : "그 사이 선택했던 부분이 바뀌어 덮어쓰지 않았습니다. 다시 선택해 요청하거나 '아래에 넣기'를 쓰세요.");
      return;
    }
    const after = message.edit?.pageId === editorBridge.pageId ? message.edit.blockIds[message.edit.blockIds.length - 1] : undefined;
    if (editorBridge.insert(message.content, after)) setMessageAt(index, { applied: "페이지에 넣었습니다 · ⌘Z 로 되돌리기" });
  };
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usePageContext, setUsePageContext] = useState(true);
  const [useWorkspace, setUseWorkspace] = useState(readWorkspacePref);
  const [sourceWarning, setSourceWarning] = useState<string | null>(null);
  const [status, setStatus] = useState<AIStatus | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 사용자가 위로 스크롤해 이전 대화를 보는 중이면 자동 스크롤하지 않는다 */
  const stickToBottomRef = useRef(true);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 탭: 대화 / 이 페이지(정리 노트) / 위키
  const [activeTab, setActiveTab] = useState<AIPanelTab>("chat");

  // 현재 페이지의 LLM 위키 정리본 (패널이 열려 있을 때만 불러온다)
  const [pageDigest, setPageDigest] = useState<{
    pageId: string;
    digest: PageDigest | null;
    stale: boolean;
    concepts: PageConceptLink[];
  } | null>(null);
  // 위키 탭: 열어 둔 주제(개념) — 없으면 위키 첫 화면
  const [openConceptId, setOpenConceptId] = useState<string | null>(null);
  useEffect(() => {
    if (!conceptRequest) return;
    setActiveTab("wiki");
    setOpenConceptId(conceptRequest.id);
  }, [conceptRequest]);
  useEffect(() => {
    if (!isOpen || !activePageId) {
      setPageDigest(null);
      return;
    }
    let cancelled = false;
    workspaceApi
      .getPageDigest(activePageId)
      .then((res) => {
        if (cancelled) return;
        setPageDigest({ pageId: activePageId, digest: res.digest, stale: res.stale, concepts: res.concepts ?? [] });
      })
      .catch(() => {
        if (!cancelled) setPageDigest(null);
      });
    return () => {
      cancelled = true;
    };
    // 탭을 다시 열 때도 최신 정리를 불러온다.
  }, [isOpen, activePageId, activeTab === "page"]);

  // 위키 개요 (탭의 ⚠ 숫자와 위키 첫 화면)
  const [wikiOverview, setWikiOverview] = useState<WikiOverview | null>(null);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiError, setWikiError] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setWikiLoading(true);
    workspaceApi
      .getWikiOverview()
      .then((overview) => {
        if (cancelled) return;
        setWikiOverview(overview);
        setWikiError(null);
      })
      .catch((err) => {
        if (!cancelled) setWikiError(err instanceof Error ? err.message : "위키를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setWikiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeTab === "wiki"]);

  const openConcept = (conceptId: string) => {
    setActiveTab("wiki");
    setOpenConceptId(conceptId);
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    workspaceApi
      .getAIStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      cancelled = true;
    };
  }, [isOpen, statusVersion]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [messages, isSending]);

  const handleListScroll = () => {
    const list = listRef.current;
    if (!list) return;
    stickToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  };

  /** 마지막(스트리밍 중인) assistant 메시지 내용을 갱신한다 */
  const updateLastAssistant = (update: (content: string) => string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), { ...last, content: update(last.content) }];
    });
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || isSending) return;
    const edit = editing ? editorBridge?.getSelection() ?? undefined : undefined;
    const history: PanelMessage[] = [...messages, { role: "user", content }];
    setMessages([...history, { role: "assistant", content: "", edit }]);
    setInput("");
    setError(null);
    setSourceWarning(null);
    setActiveTab("chat");
    setIsSending(true);
    stickToBottomRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    // 토큰마다 렌더링하지 않도록 프레임 단위로 모아서 반영한다.
    let pending = "";
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      updateLastAssistant((prev) => prev + chunk);
    };

    try {
      const result = await workspaceApi.streamChatWithAI(
        {
          // 편집 모드는 선택 부분만 보낸다: 이전 답이나 페이지 전체를 함께 주면 작은 모델이 문서 전체를 다시 써 버린다
          messages: edit ? [{ role: "user", content }] : history,
          pageTitle: usePageContext || edit ? activePageTitle : undefined,
          pageContext: usePageContext && !edit ? getActivePageContext() : undefined,
          useWorkspace: useWorkspace && !edit,
          editSelection: edit?.markdown,
        },
        (delta) => {
          pending += delta;
          if (!frame) frame = window.requestAnimationFrame(flush);
        },
        controller.signal,
        (sources, warning) => {
          setSourceWarning(warning ?? null);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== "assistant") return prev;
            return [...prev.slice(0, -1), { ...last, sources }];
          });
        },
      );
      if (frame) window.cancelAnimationFrame(frame);
      flush();
      if (result.truncated) updateLastAssistant((prev) => `${prev}\n\n…(응답 길이 제한으로 잘렸습니다)`);
      updateLastAssistant((prev) => prev || "(빈 응답)");
    } catch (err) {
      if (frame) window.cancelAnimationFrame(frame);
      flush();
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) setError(err instanceof Error ? err.message : "AI 요청에 실패했습니다.");
      // 받은 내용이 하나도 없으면 빈 말풍선을 지운다.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        return last?.role === "assistant" && !last.content ? prev.slice(0, -1) : prev;
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsSending(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  };

  const providerLabel = status ? AI_PROVIDER_LABELS[status.provider] ?? status.provider : "AI";
  const suggestions = useWorkspace
    ? ["회의록에서 결정된 사항을 정리해 줘", "첨부한 자료에서 핵심 수치를 뽑아 줘", "내 문서에서 아직 남은 할 일을 찾아 줘"]
    : activePageTitle
      ? ["이 페이지 내용을 요약해 줘", "이 문서에서 할 일 목록을 뽑아 줘", "이 글을 더 자연스럽게 다듬어 줘"]
      : ["회의록 템플릿을 만들어 줘", "주간 계획을 세우는 방법을 알려 줘"];

  return (
    <aside
      className={`ai-panel ${isOpen ? "ai-panel--open" : ""}`}
      aria-label="AI 어시스턴트"
      aria-hidden={!isOpen}
      // 닫혀 있는 동안(닫히는 애니메이션 포함) 포커스·클릭을 막는다.
      inert={!isOpen}
    >
      {/* 열리고 닫히는 동안 바깥 폭만 변하고, 안쪽은 폭을 고정해 글자가 다시 줄바꿈되지 않게 한다. */}
      <div className="ai-panel__inner">
      <header className="ai-panel__header">
        <div className="ai-panel__title">
          <AISparkleSvgIcon />
          <strong>AI 어시스턴트</strong>
          <button
            type="button"
            className="ai-panel__provider-badge"
            onClick={onOpenSettings}
            title="설정에서 AI 프로바이더 변경"
          >
            {providerLabel}
            {status?.model ? <span>· {status.model}</span> : null}
          </button>
        </div>
        <div className="ai-panel__header-actions">
          <button
            type="button"
            className="ds-btn ds-btn--ghost ds-btn--icon"
            onClick={() => {
              setMessages([]);
              setError(null);
            }}
            title="새 대화"
            aria-label="새 대화"
            disabled={isSending}
          >
            <NewChatSvgIcon />
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--ghost ds-btn--icon"
            onClick={onOpenSettings}
            title="AI 설정"
            aria-label="AI 설정"
          >
            <GearSmallSvgIcon />
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--ghost ds-btn--icon"
            onClick={onClose}
            title="AI 패널 닫기"
            aria-label="AI 패널 닫기"
          >
            <CloseSmallSvgIcon />
          </button>
        </div>
      </header>

      <div className="ai-panel__tabs" role="tablist" aria-label="AI 어시스턴트 보기">
        {(
          [
            ["chat", "대화"],
            ["page", "이 페이지"],
            ["wiki", "위키"],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`ai-panel__tab ${activeTab === tab ? "ai-panel__tab--active" : ""}`}
            onClick={() => {
              if (tab === "wiki" && activeTab === "wiki") setOpenConceptId(null);
              setActiveTab(tab);
            }}
          >
            {label}
            {tab === "wiki" && (wikiOverview?.conflicts.length ?? 0) > 0 && (
              <span className="ai-panel__tab-badge" title="문서끼리 다른 내용">
                ⚠{wikiOverview!.conflicts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === "page" && (
        <div className="ai-panel__messages">
          {!activePageId ? (
            <div className="wiki-home__muted">페이지를 열면 그 페이지의 AI 정리가 여기에 보입니다.</div>
          ) : pageDigest?.pageId === activePageId && pageDigest.digest?.status === "done" ? (
            <PageDigestView
              key={pageDigest.pageId}
              pageTitle={activePageTitle}
              digest={pageDigest.digest}
              stale={pageDigest.stale}
              concepts={pageDigest.concepts}
              onOpenConcept={openConcept}
              onAsk={() => {
                setUsePageContext(true);
                setActiveTab("chat");
                window.setTimeout(() => inputRef.current?.focus(), 30);
              }}
            />
          ) : (
            <div className="wiki-home__empty">
              <strong>{activePageTitle || "이 페이지"}</strong>
              <span>
                {pageDigest?.pageId === activePageId && pageDigest.digest?.status === "skipped"
                  ? "내용이 짧아 AI 정리를 만들지 않았습니다."
                  : "아직 AI 정리가 없습니다. 페이지 내용이 바뀌고 잠시(약 1~2분) 지나면 자동으로 정리됩니다. 설정(⌘,)의 \"LLM 위키 · 백그라운드 작업\"이 켜져 있어야 합니다."}
              </span>
            </div>
          )}
        </div>
      )}

      {activeTab === "wiki" && (
        <div className="ai-panel__messages">
          {openConceptId ? (
            <WikiConceptView
              conceptId={openConceptId}
              onBack={() => setOpenConceptId(null)}
              onOpenPage={(pageId) => onOpenSource(pageId, null)}
              backLabel="← 위키"
            />
          ) : (
            <WikiHome
              overview={wikiOverview}
              loading={wikiLoading}
              error={wikiError}
              onOpenConcept={setOpenConceptId}
              onOpenPage={(pageId) => onOpenSource(pageId, null)}
            />
          )}
        </div>
      )}

      {activeTab === "chat" && (
      <div className="ai-panel__messages" ref={listRef} onScroll={handleListScroll}>
        {status && !status.configured && (
          <div className="ai-panel__notice">
            {providerLabel} 연결 정보가 아직 설정되지 않았습니다.{" "}
            <button type="button" className="ai-panel__link-btn" onClick={onOpenSettings}>
              설정 열기
            </button>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="ai-panel__empty">
            <div className="ai-panel__empty-icon">
              <AISparkleSvgIcon size={22} />
            </div>
            <strong>무엇을 도와드릴까요?</strong>
            <span>
              {useWorkspace
                ? "워크스페이스의 문서와 첨부파일에서 찾아 출처와 함께 답해 드려요."
                : "현재 페이지 내용을 참고해서 요약, 정리, 글쓰기를 도와드려요."}
            </span>
            <div className="ai-panel__suggestions">
              {suggestions.map((item) => (
                <button key={item} type="button" className="ai-panel__suggestion" onClick={() => void send(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) => {
            const isStreaming = isSending && index === messages.length - 1 && message.role === "assistant";
            // 첫 글자가 오기 전에는 아래의 "입력 중" 표시만 보여준다.
            if (isStreaming && !message.content) return null;
            return (
            <div key={index} className={`ai-panel__message ai-panel__message--${message.role}`}>
              <div className={`ai-panel__bubble ${isStreaming ? "ai-panel__bubble--streaming" : ""}`}>
                <MessageContent
                  content={message.edit ? cleanAIMarkdown(message.content) : message.content}
                  sources={message.sources}
                  onOpenSource={(source) => onOpenSource(source.pageId, source.blockId)}
                />
              </div>
              {message.role === "assistant" && message.sources && message.sources.length > 0 && (
                <SourceList
                  sources={message.sources}
                  onOpenSource={(source) => onOpenSource(source.pageId, source.blockId)}
                />
              )}
              {message.role === "assistant" && message.edit && (
                <details className="ai-panel__original">
                  <summary>원래 내용</summary>
                  <MessageContent content={message.edit.markdown} />
                </details>
              )}
              {message.role === "assistant" && !isStreaming && (
                <div className="ai-panel__actions">
                  {message.applied ? (
                    <span className="ai-panel__applied">✓ {message.applied}</span>
                  ) : (
                    editorBridge &&
                    message.content &&
                    (message.edit ? (
                      <>
                        <button type="button" className="ai-panel__apply-btn ai-panel__apply-btn--primary" onClick={() => applyMessage(index, "replace")}>
                          선택 부분 바꾸기
                        </button>
                        <button type="button" className="ai-panel__apply-btn" onClick={() => applyMessage(index, "insert")}>
                          아래에 넣기
                        </button>
                      </>
                    ) : (
                      <button type="button" className="ai-panel__apply-btn" onClick={() => applyMessage(index, "insert")} title="커서가 있는 블록 아래에 넣습니다">
                        페이지에 넣기
                      </button>
                    ))
                  )}
                  <button
                    type="button"
                    className="ai-panel__copy-btn"
                    onClick={() => void navigator.clipboard?.writeText(message.edit ? cleanAIMarkdown(message.content) : message.content)}
                  >
                    복사
                  </button>
                </div>
              )}
            </div>
            );
          })
        )}

        {isSending && !messages[messages.length - 1]?.content && (
          <div className="ai-panel__message ai-panel__message--assistant">
            <div className="ai-panel__bubble ai-panel__bubble--typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {sourceWarning && <div className="ai-panel__notice">{sourceWarning}</div>}
        {error && <div className="ai-panel__error" role="alert">{error}</div>}
      </div>
      )}

      {activeTab === "chat" && (
      <div className="ai-panel__composer">
        <label
          className="ai-panel__context-toggle"
          title="문서와 첨부파일 전체에서 질문과 관련된 내용을 찾아 출처와 함께 답합니다"
        >
          <input
            type="checkbox"
            checked={useWorkspace}
            onChange={(event) => {
              setUseWorkspace(event.target.checked);
              writeWorkspacePref(event.target.checked);
            }}
          />
          <span>워크스페이스 전체 참고</span>
        </label>
        <label className="ai-panel__context-toggle" title="현재 보고 있는 페이지 내용을 함께 전달합니다">
          <input
            type="checkbox"
            checked={usePageContext}
            onChange={(event) => setUsePageContext(event.target.checked)}
          />
          <span>
            현재 페이지 참고
            {usePageContext && activePageTitle ? <em> · {activePageTitle}</em> : null}
          </span>
        </label>
        {editing && (
          <div className="ai-panel__edit-target">
            <div className="ai-panel__edit-chip">
              <span>✎ 선택한 블록 {selectionCount}개를 고칩니다</span>
              <button type="button" onClick={() => setIgnoreSelection(true)} aria-label="선택 무시하고 일반 질문하기" title="선택 무시">
                ✕
              </button>
            </div>
            <div className="ai-panel__edit-actions">
              {EDIT_ACTIONS.map(([label, prompt]) => (
                <button key={label} type="button" className="ai-panel__suggestion" disabled={isSending} title={prompt} onClick={() => void send(prompt)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ai-panel__input-wrap">
          <textarea
            ref={inputRef}
            className="ai-panel__input"
            value={input}
            rows={2}
            placeholder={editing ? "선택한 부분을 어떻게 바꿀까요? (Enter 전송)" : "AI에게 질문하기… (Enter 전송, Shift+Enter 줄바꿈)"}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isSending ? (
            <button
              type="button"
              className="ds-btn ds-btn--outline ai-panel__send-btn"
              onClick={stop}
              title="응답 생성 중지"
            >
              중지
            </button>
          ) : (
            <button
              type="button"
              className="ds-btn ds-btn--primary ai-panel__send-btn"
              onClick={() => void send(input)}
              disabled={!input.trim()}
            >
              전송
            </button>
          )}
        </div>
      </div>
      )}
      </div>
    </aside>
  );
}
