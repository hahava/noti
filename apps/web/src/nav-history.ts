/** 탭마다의 방문 기록 (⌘[ 뒤로 / ⌘] 앞으로). 빈 탭("")은 기록하지 않는다. */
export interface NavHistory {
  back: string[];
  forward: string[];
  current?: string;
}

const LIMIT = 50;

export const emptyHistory = (): NavHistory => ({ back: [], forward: [] });

/** 새로 연 페이지를 기록한다: 지금 페이지는 뒤로 목록에, 앞으로 목록은 비운다 (브라우저와 같음) */
export function recordVisit(history: NavHistory, pageId: string): NavHistory {
  if (!pageId || history.current === pageId) return history;
  if (history.current === undefined) return { ...history, current: pageId };
  return { back: [...history.back, history.current].slice(-LIMIT), forward: [], current: pageId };
}

/** 뒤로/앞으로 한 칸. 지워진 페이지는 건너뛴다. 갈 곳이 없으면 null. */
export function stepHistory(
  history: NavHistory,
  direction: "back" | "forward",
  exists: (pageId: string) => boolean,
): { history: NavHistory; target: string } | null {
  const from = [...history[direction]];
  const to = [...history[direction === "back" ? "forward" : "back"]];
  while (from.length) {
    const target = from.pop()!;
    if (!exists(target)) continue;
    if (history.current) to.push(history.current);
    const next = direction === "back" ? { back: from, forward: to } : { back: to, forward: from };
    return { history: { ...next, current: target }, target };
  }
  return null;
}
