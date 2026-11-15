import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CollectionRow } from "@noty/shared/collection-types";
import {
  TIMELINE_DAY_WIDTH,
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
  { scale: "day", label: "일" },
  { scale: "week", label: "주" },
  { scale: "month", label: "월" },
];
const ROW_HEIGHT = 34;

type Drag = { rowId: string; mode: "move" | "start" | "end"; x: number; delta: number };

/**
 * 타임라인(간트) 뷰: 시작·끝 날짜 속성으로 가로 막대를 그린다.
 * 막대를 끌면 옮기고, 양 끝을 끌면 기간을 바꾼다. 날짜 없는 행은 줄을 누르면 그날로 잡힌다.
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
  onOpenRow: (row: CollectionRow, event?: React.MouseEvent) => void;
  onAddRow: (start: string) => void;
}) {
  const [scale, setScale] = useState<TimelineScale>("week");
  const [drag, setDrag] = useState<Drag | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => toDayNumber(new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString())!, []);
  const dayWidth = TIMELINE_DAY_WIDTH[scale];

  const items = rows.map((row) => ({
    row,
    span: rowSpan(row.values?.[startPropertyId], endPropertyId ? row.values?.[endPropertyId] : undefined),
  }));
  const spans = items.flatMap((item) => (item.span ? [item.span] : []));
  const range = timelineRange(spans, today, scale);
  const totalDays = range.end - range.start + 1;
  const x = (day: number) => (day - range.start) * dayWidth;

  // 기간 앞쪽이 바뀌면(막대를 옮겨서) 스크롤을 그만큼 보정해 화면이 밀리지 않게 한다
  const prevStart = useRef(range.start);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevStart.current !== range.start) el.scrollLeft -= (range.start - prevStart.current) * dayWidth;
    prevStart.current = range.start;
  }, [range.start, dayWidth]);

  // 처음 열 때와 단위를 바꿀 때 오늘이 보이게 한다
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) =>
      setDrag((current) => current && { ...current, delta: Math.round((event.clientX - current.x) / dayWidth) });
    // 효과가 렌더마다 다시 걸리므로 drag 는 늘 최신 값이다
    const onUp = () => {
      const item = items.find((i) => i.row.id === drag.rowId);
      if (item?.span && drag.delta !== 0) {
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
    setDrag({ rowId, mode, x: event.clientX, delta: 0 });
  };

  const dayAt = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return range.start + Math.floor((event.clientX - rect.left) / dayWidth);
  };

  const ticks = headerTicks(range, scale);
  const groups = headerGroups(range, scale);
  const width = totalDays * dayWidth;

  return (
    <div className="ndb-timeline">
      <div className="ndb-timeline__bar">
        <div className="ndb-calendar__nav" role="group" aria-label="타임라인 단위">
          {SCALES.map((item) => (
            <button
              key={item.scale}
              type="button"
              aria-pressed={scale === item.scale}
              className={scale === item.scale ? "ndb-timeline__scale--active" : undefined}
              onClick={() => setScale(item.scale)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ndb-calendar__nav">
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTo({ left: Math.max(0, x(today) - el.clientWidth / 3), behavior: "smooth" });
            }}
          >
            오늘
          </button>
        </div>
      </div>

      <div className="ndb-timeline__frame">
        <div className="ndb-timeline__names">
          <div className="ndb-timeline__names-head">이름</div>
          {items.map(({ row }) => (
            <button key={row.id} type="button" className="ndb-timeline__name" style={{ height: ROW_HEIGHT }} onClick={(e) => onOpenRow(row, e)}>
              <span>{row.icon || "📄"}</span>
              <span className="ndb-timeline__name-text">{row.title || "제목 없음"}</span>
            </button>
          ))}
          <button type="button" className="ndb-timeline__new" style={{ height: ROW_HEIGHT }} onClick={() => onAddRow(fromDayNumber(today))}>
            + 새로 만들기
          </button>
        </div>

        <div className="ndb-timeline__scroll" ref={scrollRef}>
          <div style={{ width, position: "relative" }}>
            <div className="ndb-timeline__head">
              <div className="ndb-timeline__groups">
                {groups.map((g) => (
                  <span key={g.day} style={{ left: x(g.day), width: g.days * dayWidth }}>
                    {g.label}
                  </span>
                ))}
              </div>
              <div className="ndb-timeline__ticks">
                {ticks.map((t) => (
                  <span
                    key={t.day}
                    className={t.day === today ? "ndb-timeline__tick--today" : undefined}
                    style={{ left: x(t.day), width: scale === "day" ? dayWidth : undefined }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="ndb-timeline__body" style={{ height: (items.length + 1) * ROW_HEIGHT }}>
              {ticks.map((t) => (
                <div key={t.day} className="ndb-timeline__gridline" style={{ left: x(t.day) }} />
              ))}
              <div className="ndb-timeline__today" style={{ left: x(today) + dayWidth / 2 }} />
              {items.map(({ row, span }, index) => {
                const live = span && drag?.rowId === row.id ? dragSpan(span, drag.mode, drag.delta) : span;
                return (
                  <div
                    key={row.id}
                    className={`ndb-timeline__lane ${span ? "" : "ndb-timeline__lane--unscheduled"}`}
                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                    title={span ? undefined : "누르면 이 날짜로 일정을 잡습니다"}
                    onClick={(event) => {
                      if (span) return;
                      const day = fromDayNumber(dayAt(event));
                      onChangeDates(row, day, day);
                    }}
                  >
                    {live && live.end >= range.start && live.start <= range.end && (
                      <div
                        className={`ndb-timeline__item ${drag?.rowId === row.id ? "ndb-timeline__item--dragging" : ""}`}
                        style={{
                          left: x(Math.max(live.start, range.start)),
                          width: (Math.min(live.end, range.end) - Math.max(live.start, range.start) + 1) * dayWidth,
                        }}
                        title={`${row.title || "제목 없음"} · ${fromDayNumber(live.start)}${live.end > live.start ? ` → ${fromDayNumber(live.end)}` : ""}`}
                        onPointerDown={(e) => startDrag(e, row.id, "move")}
                        onDoubleClick={(e) => onOpenRow(row, e)}
                      >
                        {endPropertyId && (
                          <span className="ndb-timeline__handle ndb-timeline__handle--start" onPointerDown={(e) => startDrag(e, row.id, "start")} />
                        )}
                        <span className="ndb-timeline__item-label">
                          {row.icon ? `${row.icon} ` : ""}
                          {row.title || "제목 없음"}
                        </span>
                        {endPropertyId && (
                          <span className="ndb-timeline__handle ndb-timeline__handle--end" onPointerDown={(e) => startDrag(e, row.id, "end")} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
