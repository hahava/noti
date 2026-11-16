import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CollectionRow } from "@noty/shared/collection-types";
import {
  TIMELINE_DAY_WIDTH,
  dayDate,
  dragSpan,
  fromDayNumber,
  headerGroups,
  headerTicks,
  rowSpan,
  timelineRange,
  toDayNumber,
  type TimelineScale,
} from "./timeline";

const SCALES: Array<{ scale: TimelineScale; label: string }> = [
  { scale: "week", label: "주" },
  { scale: "month", label: "월" },
  { scale: "quarter", label: "분기" },
  { scale: "year", label: "연" },
];
const LANE = 40;
const HEAD = 50;
/** 이보다 좁은 막대는 제목을 막대 오른쪽에 쓴다 */
const LABEL_INSIDE_MIN = 56;

type Drag = { rowId: string; mode: "move" | "start" | "end"; x: number; delta: number; moved: boolean };

/**
 * 타임라인(간트) 뷰. 노션처럼 이름 칸 없이 카드 막대에 제목을 쓴다.
 * 막대: 누르면 상세, 끌면 이동, 양 끝을 끌면 기간 변경. 날짜 없는 행과 맨 아래 빈 줄은 누른 날짜로 일정을 잡는다.
 */
export function CollectionTimeline({
  rows,
  startPropertyId,
  endPropertyId,
  onChangeDates,
  onOpenRow,
  onAddRow,
}: {
  rows: CollectionRow[];
  startPropertyId: string;
  /** 없으면 시작 날짜 하루짜리 막대 */
  endPropertyId?: string;
  onChangeDates: (row: CollectionRow, start: string, end: string) => void;
  onOpenRow: (row: CollectionRow) => void;
  onAddRow: (start: string) => void;
}) {
  const [scale, setScale] = useState<TimelineScale>("month");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ lane: string; day: number } | null>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => toDayNumber(new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString())!, []);
  const dayWidth = TIMELINE_DAY_WIDTH[scale];

  const items = rows.map((row) => ({
    row,
    span: rowSpan(row.values?.[startPropertyId], endPropertyId ? row.values?.[endPropertyId] : undefined),
  }));
  const range = timelineRange(
    items.flatMap((item) => (item.span ? [item.span] : [])),
    today,
    scale,
  );
  const x = (day: number) => (day - range.start) * dayWidth;
  const width = (range.end - range.start + 1) * dayWidth;
  const ticks = useMemo(() => headerTicks(range, scale), [range.start, range.end, scale]);
  const groups = useMemo(() => headerGroups(range, scale), [range.start, range.end, scale]);

  const scrollToDay = (day: number, smooth = true) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: Math.max(0, x(day) - el.clientWidth / 3), behavior: smooth ? "smooth" : "auto" });
  };

  // 단위를 바꿔도 보던 날짜가 그대로 가운데 오게 하고, 막대를 옮겨 기간 앞쪽이 바뀌면 화면이 밀리지 않게 보정한다
  const anchor = useRef<{ scale: TimelineScale; start: number; centerDay: number | null }>({ scale, start: range.start, centerDay: null });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = anchor.current;
    if (prev.centerDay === null) el.scrollLeft = Math.max(0, x(today) - el.clientWidth / 3);
    else if (prev.scale !== scale) el.scrollLeft = Math.max(0, x(prev.centerDay) - el.clientWidth / 2);
    else if (prev.start !== range.start) el.scrollLeft += (prev.start - range.start) * dayWidth;
    anchor.current = { scale, start: range.start, centerDay: range.start + (el.scrollLeft + el.clientWidth / 2) / dayWidth };
    setView({ left: el.scrollLeft, width: el.clientWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, range.start]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      anchor.current.centerDay = range.start + (el.scrollLeft + el.clientWidth / 2) / dayWidth;
      setView({ left: el.scrollLeft, width: el.clientWidth });
    };
    el.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [range.start, dayWidth]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) =>
      setDrag((current) => {
        if (!current) return current;
        const dx = event.clientX - current.x;
        return { ...current, delta: Math.round(dx / dayWidth), moved: current.moved || Math.abs(dx) > 3 };
      });
    // 효과가 렌더마다 다시 걸리므로 drag 는 늘 최신 값이다
    const onUp = () => {
      const item = items.find((i) => i.row.id === drag.rowId);
      if (item && !drag.moved) onOpenRow(item.row);
      else if (item?.span && drag.delta !== 0) {
        const next = dragSpan(item.span, drag.mode, drag.delta);
        onChangeDates(item.row, fromDayNumber(next.start), fromDayNumber(next.end));
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  });

  const startDrag = (event: React.PointerEvent, rowId: string, mode: Drag["mode"]) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDrag({ rowId, mode, x: event.clientX, delta: 0, moved: false });
  };

  const dayAt = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return range.start + Math.floor((event.clientX - rect.left) / dayWidth);
  };
  const hoverProps = (lane: string) => ({
    // 편집기(ProseMirror)가 mousedown 으로 블록을 선택하며 다시 그려 click 이 사라지지 않게 한다
    onPointerDown: (event: React.PointerEvent) => event.preventDefault(),
    onMouseMove: (event: React.MouseEvent) => {
      const day = dayAt(event);
      setHover((current) => (current?.lane === lane && current.day === day ? current : { lane, day }));
    },
    onMouseLeave: () => setHover(null),
  });
  const ghost = (lane: string) =>
    hover?.lane === lane && !drag && (
      <div className="ndb-timeline__ghost" style={{ left: x(hover.day), width: Math.max(dayWidth, 28) }}>
        +
      </div>
    );

  const visibleMonth = dayDate(range.start + Math.floor((view.left + 24) / dayWidth));
  const showDays = scale === "week" || scale === "month";
  // 주말 음영: 월요일에서 시작하는 7일 무늬를 기간 시작 요일만큼 민다
  const weekendStyle = showDays
    ? {
        backgroundImage: `linear-gradient(to right, transparent ${5 * dayWidth}px, rgba(55, 53, 47, 0.03) ${5 * dayWidth}px)`,
        backgroundSize: `${7 * dayWidth}px 100%`,
        backgroundPositionX: ((8 - dayDate(range.start).getUTCDay()) % 7) * dayWidth,
      }
    : undefined;

  return (
    <div className="ndb-timeline">
      <div className="ndb-timeline__bar">
        <strong>
          {visibleMonth.getUTCFullYear()}년 {visibleMonth.getUTCMonth() + 1}월
        </strong>
        <div className="ndb-timeline__controls">
          <div className="ndb-timeline__scales" role="group" aria-label="타임라인 단위">
            {SCALES.map((item) => (
              <button key={item.scale} type="button" aria-pressed={scale === item.scale} onClick={() => setScale(item.scale)}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="ndb-calendar__nav">
            <button type="button" aria-label="이전" onClick={() => scrollRef.current?.scrollBy({ left: -view.width * 0.8, behavior: "smooth" })}>
              ‹
            </button>
            <button type="button" onClick={() => scrollToDay(today)}>
              오늘
            </button>
            <button type="button" aria-label="다음" onClick={() => scrollRef.current?.scrollBy({ left: view.width * 0.8, behavior: "smooth" })}>
              ›
            </button>
          </div>
        </div>
      </div>

      <div className="ndb-timeline__frame">
        <div className="ndb-timeline__scroll" ref={scrollRef}>
          <div style={{ width, position: "relative" }}>
            <div className="ndb-timeline__head" style={{ height: HEAD }}>
              {groups.map((g) => (
                <span key={g.day} className="ndb-timeline__group" style={{ left: x(g.day) }}>
                  {g.label}
                </span>
              ))}
              {ticks.map((t) => (
                <span
                  key={t.day}
                  className={`ndb-timeline__tick ${t.day === today ? "ndb-timeline__tick--today" : ""}`}
                  style={{ left: x(t.day), width: showDays ? dayWidth : undefined }}
                >
                  <i>{t.label}</i>
                </span>
              ))}
            </div>

            <div className="ndb-timeline__body" style={{ height: (items.length + 1) * LANE + 14, ...weekendStyle }}>
              <div className="ndb-timeline__today" style={{ left: x(today) + dayWidth / 2 }} />
              {items.map(({ row, span }, index) => {
                const inRange = span && span.end >= range.start && span.start <= range.end;
                const live = !inRange ? null : drag?.rowId === row.id && drag.moved ? dragSpan(span, drag.mode, drag.delta) : span;
                const barWidth = live ? Math.max((live.end - live.start + 1) * dayWidth, 10) : 0;
                const title = `${row.icon ? `${row.icon} ` : ""}${row.title || "제목 없음"}`;
                return (
                  <div
                    key={row.id}
                    className="ndb-timeline__lane"
                    style={{ top: index * LANE, height: LANE }}
                    {...(span ? {} : hoverProps(row.id))}
                    onClick={(event) => {
                      if (span) return;
                      const day = fromDayNumber(dayAt(event));
                      onChangeDates(row, day, day);
                    }}
                  >
                    {!span && <span className="ndb-timeline__unscheduled">{title} · 눌러서 날짜 정하기</span>}
                    {span && !inRange && <span className="ndb-timeline__unscheduled">{title} · 표시 범위 밖 ({fromDayNumber(span.start)})</span>}
                    {!span && ghost(row.id)}
                    {live && (
                      <div
                        className={`ndb-timeline__item ${drag?.rowId === row.id && drag.moved ? "ndb-timeline__item--dragging" : ""}`}
                        style={{ left: x(live.start), width: barWidth }}
                        title={`${title} · ${fromDayNumber(live.start)}${live.end > live.start ? ` → ${fromDayNumber(live.end)}` : ""}`}
                        onPointerDown={(e) => startDrag(e, row.id, "move")}
                      >
                        {endPropertyId && <span className="ndb-timeline__handle ndb-timeline__handle--start" onPointerDown={(e) => startDrag(e, row.id, "start")} />}
                        <span className={`ndb-timeline__label ${barWidth < LABEL_INSIDE_MIN ? "ndb-timeline__label--outside" : ""}`}>{title}</span>
                        {endPropertyId && <span className="ndb-timeline__handle ndb-timeline__handle--end" onPointerDown={(e) => startDrag(e, row.id, "end")} />}
                      </div>
                    )}
                  </div>
                );
              })}
              <div
                className="ndb-timeline__lane ndb-timeline__lane--new"
                style={{ top: items.length * LANE, height: LANE }}
                {...hoverProps("new")}
                onClick={(event) => onAddRow(fromDayNumber(dayAt(event)))}
              >
                <span className="ndb-timeline__unscheduled">+ 새로 만들기</span>
                {ghost("new")}
              </div>
            </div>
          </div>
        </div>

        {/* 화면 밖에 있는 막대: 가장자리 화살표를 누르면 그쪽으로 간다 */}
        {items.map(({ row, span }, index) => {
          if (!span || view.width === 0 || span.end < range.start || span.start > range.end) return null;
          const side = x(span.end + 1) < view.left ? "left" : x(span.start) > view.left + view.width ? "right" : null;
          return (
            side && (
              <button
                key={row.id}
                type="button"
                className={`ndb-timeline__jump ndb-timeline__jump--${side}`}
                style={{ top: HEAD + index * LANE + (LANE - 22) / 2 }}
                aria-label={`${row.title || "제목 없음"}(으)로 이동`}
                onClick={() => scrollToDay(span.start)}
              >
                {side === "left" ? `← ${row.title || "제목 없음"}` : `${row.title || "제목 없음"} →`}
              </button>
            )
          );
        })}
      </div>
    </div>
  );
}
