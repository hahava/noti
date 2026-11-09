/**
 * 페이지 템플릿 목록. 내 템플릿은 서버(/api/templates)에 계정별로 저장된다.
 * shortcut: 기본 제공 템플릿은 클라이언트에 하드코딩, 많아지면 서버 카탈로그(index.json + 템플릿별 파일)로 옮긴다.
 */
export interface PageTemplate {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  /** BlockNote 블록 (id 없이) — 제목 블록 아래에 들어간다 */
  blocks: unknown[];
}

const bold = (text: string) => ({ type: "text", text, styles: { bold: true } });
const h2 = (text: string) => ({ type: "heading", props: { level: 2 }, content: text });
const h3 = (text: string) => ({ type: "heading", props: { level: 3 }, content: text });
const p = (text = "") => ({ type: "paragraph", content: text });
const field = (label: string) => ({ type: "paragraph", content: [bold(`${label}  `)] });
const todo = (text = "") => ({ type: "checkListItem", content: text });
const bullet = (text = "") => ({ type: "bulletListItem", content: text });
const num = (text = "") => ({ type: "numberedListItem", content: text });

export const PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: "meeting-notes",
    name: "회의록",
    icon: "📝",
    category: "업무",
    description: "참석자, 안건, 결정 사항, 후속 조치를 정리합니다.",
    blocks: [
      field("일시"),
      field("참석자"),
      h2("안건"),
      num("안건 1"),
      num("안건 2"),
      h2("논의 내용"),
      bullet(),
      h2("결정 사항"),
      bullet(),
      h2("후속 조치"),
      todo("담당자 · 할 일 · 기한"),
    ],
  },
  {
    id: "project-brief",
    name: "프로젝트 브리프",
    icon: "🗂",
    category: "업무",
    description: "목표, 범위, 일정, 위험 요소를 한 장에 담습니다.",
    blocks: [
      field("담당"),
      field("기간"),
      h2("배경"),
      p("왜 이 프로젝트를 하나요?"),
      h2("목표"),
      bullet("측정 가능한 목표 1"),
      h2("범위"),
      h3("포함"),
      bullet(),
      h3("제외"),
      bullet(),
      h2("일정"),
      todo("기획"),
      todo("개발"),
      todo("출시"),
      h2("위험 요소"),
      bullet(),
    ],
  },
  {
    id: "okr",
    name: "OKR",
    icon: "📊",
    category: "업무",
    description: "분기 목표와 핵심 결과를 정리합니다.",
    blocks: [
      field("분기"),
      h2("목표 1"),
      todo("핵심 결과 1-1"),
      todo("핵심 결과 1-2"),
      h2("목표 2"),
      todo("핵심 결과 2-1"),
      todo("핵심 결과 2-2"),
      h2("회고"),
      p(),
    ],
  },
  {
    id: "weekly-todo",
    name: "주간 할 일",
    icon: "✅",
    category: "개인",
    description: "요일별로 할 일을 나눠 한 주를 계획합니다.",
    blocks: [
      h2("이번 주 목표"),
      bullet(),
      ...["월", "화", "수", "목", "금"].flatMap((day) => [h3(`${day}요일`), todo()]),
      h2("주말"),
      todo(),
    ],
  },
  {
    id: "daily-journal",
    name: "하루 일기",
    icon: "🌤",
    category: "개인",
    description: "오늘 한 일, 감사한 일, 내일 할 일을 남깁니다.",
    blocks: [
      field("기분"),
      h2("오늘 한 일"),
      bullet(),
      h2("감사한 일"),
      bullet(),
      h2("내일 할 일"),
      todo(),
    ],
  },
  {
    id: "reading-log",
    name: "독서 기록",
    icon: "📚",
    category: "학습",
    description: "책 정보, 인상 깊은 구절, 느낀 점을 기록합니다.",
    blocks: [
      field("저자"),
      field("읽은 기간"),
      field("별점"),
      h2("한 줄 요약"),
      p(),
      h2("인상 깊은 구절"),
      bullet(),
      h2("느낀 점"),
      p(),
    ],
  },
  {
    id: "study-notes",
    name: "공부 노트",
    icon: "🎓",
    category: "학습",
    description: "핵심 개념, 예시, 복습 질문으로 정리합니다.",
    blocks: [
      field("주제"),
      h2("핵심 개념"),
      bullet(),
      h2("예시"),
      p(),
      h2("헷갈리는 점"),
      bullet(),
      h2("복습 질문"),
      todo(),
    ],
  },
  {
    id: "wiki-doc",
    name: "위키 문서",
    icon: "📖",
    category: "위키",
    description: "개요, 사용 방법, 자주 묻는 질문 구조의 팀 문서입니다.",
    blocks: [
      field("관리자"),
      field("최종 확인"),
      h2("개요"),
      p(),
      h2("사용 방법"),
      num(),
      h2("자주 묻는 질문"),
      h3("Q. "),
      p("A. "),
      h2("관련 문서"),
      bullet(),
    ],
  },
];

export const USER_TEMPLATE_CATEGORY = "내 템플릿";
const LEGACY_USER_TEMPLATES_KEY = "noty.userTemplates";

/**
 * 서버 저장 이전에 이 브라우저(localStorage)에 저장해 둔 내 템플릿을 꺼내고 지운다.
 * 로그인 후 한 번 서버로 옮기는 데만 쓴다.
 */
export function takeLegacyUserTemplates(): PageTemplate[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LEGACY_USER_TEMPLATES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.name === "string" && Array.isArray(t.blocks)) : [];
  } catch {
    return [];
  }
}

export function clearLegacyUserTemplates(): void {
  try {
    window.localStorage.removeItem(LEGACY_USER_TEMPLATES_KEY);
  } catch {
    // 지울 수 없으면 다음 로그인 때 다시 옮기기를 시도한다 (같은 이름으로 중복될 수 있음)
  }
}

// 템플릿에 넣지 않는 블록: 하위 페이지·데이터베이스는 원본과 연결돼 있어 복사하면 같은 대상을 가리킨다.
const LINKED_BLOCK_TYPES = new Set(["page", "canvas", "collection", "linkedCollection"]);

/**
 * 페이지 본문 → 템플릿 블록.
 * 제목(첫 블록)은 빼고, 블록 id 는 지워서 적용할 때 새로 매기게 한다.
 * structureOnly 면 제목(heading)과 굵은 글씨 라벨만 남기고 본문 글은 비운다.
 */
export function pageBlocksToTemplate(blocks: readonly unknown[], structureOnly: boolean): unknown[] {
  const convert = (list: readonly any[]): any[] =>
    list
      .filter((block) => block && typeof block === "object" && !LINKED_BLOCK_TYPES.has(block.type))
      .map(({ id: _id, children, ...block }) => {
        const next: any = { ...block };
        if (structureOnly && block.type !== "heading" && Array.isArray(block.content)) {
          next.content = block.content.filter((item: any) => item?.styles?.bold);
          if (block.type === "checkListItem") next.props = { ...block.props, checked: false };
        }
        if (Array.isArray(children) && children.length > 0) next.children = convert(children);
        return next;
      });
  return convert(blocks.slice(1));
}
