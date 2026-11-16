/** 타임라인(간트) 뷰의 날짜 계산. 날짜는 "YYYY-MM-DD" 문자열, 내부 계산은 UTC 일 번호로 한다(서머타임 영향 없음). */

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 5 * 366;

export type TimelineScale = "day" | "week" | "month";

export function toDayNumber(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

export function fromDayNumber(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 행의 시작·끝 날(포함). 끝이 없거나 시작보다 앞이면 하루짜리로 본다. 시작이 없으면 null. */
export function rowSpan(startIso: unknown, endIso: unknown): { start: number; end: number } | null {
  const start = toDayNumber(startIso);
  if (start === null) return null;
  const end = toDayNumber(endIso);
  return { start, end: end !== null && end >= start ? end : start };
}

/** 보여 줄 기간: 모든 막대와 오늘을 담고 앞뒤로 여유를 둔 뒤 달의 처음·끝에 맞춘다(막대를 조금 옮겨도 기간이 덜 바뀌게). */
export function timelineRange(spans: Array<{ start: number; end: number }>, today: number, scale: TimelineScale) {
  const pad = scale === "day" ? 14 : scale === "week" ? 28 : 90;
  let start = today;
  let end = today;
  for (const span of spans) {
    start = Math.min(start, span.start);
    end = Math.max(end, span.end);
  }
  // 9999년 같은 날짜 하나로 날마다 그리는 칸이 수백만 개가 되지 않게 오늘 ±5년으로 자른다
  start = Math.max(start - pad, today - MAX_RANGE_DAYS);
  end = Math.min(end + pad * 2, today + MAX_RANGE_DAYS);
  const s = new Date(start * DAY_MS);
  const e = new Date(end * DAY_MS);
  start = Math.floor(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) / DAY_MS);
  end = Math.floor(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0) / DAY_MS);
  return { start, end };
}
