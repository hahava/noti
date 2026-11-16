/** 타임라인(간트) 뷰의 날짜 계산. 날짜는 "YYYY-MM-DD" 문자열, 내부 계산은 UTC 일 번호로 한다(서머타임 영향 없음). */

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 5 * 366;

/** 노션처럼 한 화면에 대략 주·월·분기·연이 들어오는 확대 단계 */
export type TimelineScale = "week" | "month" | "quarter" | "year";
/** 하루의 가로 폭(px) */
export const TIMELINE_DAY_WIDTH: Record<TimelineScale, number> = { week: 96, month: 32, quarter: 9, year: 2.6 };

export function toDayNumber(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

export function fromDayNumber(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function dayDate(day: number): Date {
  return new Date(day * DAY_MS);
}

/** 행의 시작·끝 날(포함). 끝이 없거나 시작보다 앞이면 하루짜리로 본다. 시작이 없으면 null. */
export function rowSpan(startIso: unknown, endIso: unknown): { start: number; end: number } | null {
  const start = toDayNumber(startIso);
  if (start === null) return null;
  const end = toDayNumber(endIso);
  return { start, end: end !== null && end >= start ? end : start };
}

/** 보여 줄 기간: 모든 막대와 오늘을 담고 여유를 둔 뒤 달의 처음·끝에 맞춘다(막대를 조금 옮겨도 기간이 덜 바뀌게). */
export function timelineRange(spans: Array<{ start: number; end: number }>, today: number, scale: TimelineScale) {
  const pad = { week: 45, month: 120, quarter: 300, year: 730 }[scale];
  let start = today;
  let end = today;
  for (const span of spans) {
    start = Math.min(start, span.start);
    end = Math.max(end, span.end);
  }
  // 9999년 같은 날짜 하나로 그리는 칸이 수백만 개가 되지 않게 오늘 ±5년으로 자른다
  start = Math.max(start - pad, today - MAX_RANGE_DAYS);
  end = Math.min(end + pad, today + MAX_RANGE_DAYS);
  const s = dayDate(start);
  const e = dayDate(end);
  start = Math.floor(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) / DAY_MS);
  end = Math.floor(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0) / DAY_MS);
  return { start, end };
}

/** 끌기 결과: 이동은 둘 다, 양 끝 조절은 한쪽만 옮기고 끝이 시작보다 앞서지 않게 한다. */
export function dragSpan(
  span: { start: number; end: number },
  mode: "move" | "start" | "end",
  deltaDays: number,
): { start: number; end: number } {
  if (mode === "move") return { start: span.start + deltaDays, end: span.end + deltaDays };
  if (mode === "start") return { start: Math.min(span.start + deltaDays, span.end), end: span.end };
  return { start: span.start, end: Math.max(span.end + deltaDays, span.start) };
}

/** 머리글 눈금: 주·월 단계는 날마다, 분기는 월요일마다, 연은 1일마다 */
export function headerTicks(range: { start: number; end: number }, scale: TimelineScale): Array<{ day: number; label: string }> {
  const ticks: Array<{ day: number; label: string }> = [];
  for (let day = range.start; day <= range.end; day++) {
    const date = dayDate(day);
    if (scale === "week" || scale === "month") ticks.push({ day, label: String(date.getUTCDate()) });
    else if (scale === "quarter" && date.getUTCDay() === 1) ticks.push({ day, label: String(date.getUTCDate()) });
    else if (scale === "year" && date.getUTCDate() === 1) ticks.push({ day, label: `${date.getUTCMonth() + 1}월` });
  }
  return ticks;
}

/** 위쪽 머리글: 연 단계는 해, 나머지는 달 */
export function headerGroups(range: { start: number; end: number }, scale: TimelineScale): Array<{ day: number; days: number; label: string }> {
  const groups: Array<{ day: number; days: number; label: string }> = [];
  for (let day = range.start; day <= range.end; day++) {
    const date = dayDate(day);
    const label = scale === "year" ? `${date.getUTCFullYear()}년` : `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.days++;
    else groups.push({ day, days: 1, label });
  }
  return groups;
}
