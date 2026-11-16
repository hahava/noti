import { useEffect, useMemo, useRef, useState } from "react";
import { Gantt, Willow, type IApi, type IScaleConfig, type ITask } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import type { CollectionRow } from "@noty/shared/collection-types";
import { fromDayNumber, rowSpan, timelineRange, toDayNumber, type TimelineScale } from "./timeline";

const SCALES: Array<{ scale: TimelineScale; label: string }> = [
  { scale: "day", label: "일" },
  { scale: "week", label: "주" },
  { scale: "month", label: "월" },
];

const monthLabel = (d: Date) => `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
const SCALE_CONFIG: Record<TimelineScale, { cellWidth: number; scales: IScaleConfig[] }> = {
  day: {
    cellWidth: 34,
    scales: [
      { unit: "month", step: 1, format: monthLabel },
      { unit: "day", step: 1, format: (d: Date) => String(d.getDate()) },
    ],
  },
  week: {
    cellWidth: 90,
    scales: [
      { unit: "month", step: 1, format: monthLabel },
      { unit: "week", step: 1, format: (d: Date) => `${d.getMonth() + 1}/${d.getDate()}` },
    ],
  },
  month: {
    cellWidth: 110,
    scales: [
      { unit: "year", step: 1, format: (d: Date) => `${d.getFullYear()}년` },
      { unit: "month", step: 1, format: (d: Date) => `${d.getMonth() + 1}월` },
    ],
  },
};

const ROW_HEIGHT = 36;
const SCALE_HEIGHT = 30;
const COLUMNS = [{ id: "text", header: "이름", flexgrow: 1 }];

/** 일 번호 → 그날 0시(현지 시각) */
const toLocalDate = (day: number) => new Date(`${fromDayNumber(day)}T00:00:00`);
/** 현지 시각 Date → 일 번호 */
const localDay = (date: Date) =>
  toDayNumber(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`)!;

/**
 * 타임라인(간트) 뷰. 그리기·끌기는 SVAR Gantt 가 맡고, 이 컴포넌트는 행 ⇄ 작업 변환과 저장만 한다.
 * 데이터베이스의 끝 날짜는 그날을 포함하고, SVAR 의 end 는 다음 날 0시(포함 안 함)라 하루씩 맞춘다.
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
  const [scale, setScale] = useState<TimelineScale>("week");
  const apiRef = useRef<IApi | null>(null);
  const today = useMemo(() => localDay(new Date()), []);

  const scheduled = rows.flatMap((row) => {
    const span = rowSpan(row.values?.[startPropertyId], endPropertyId ? row.values?.[endPropertyId] : undefined);
    return span ? [{ row, span }] : [];
  });
  const unscheduled = rows.filter((row) => !rowSpan(row.values?.[startPropertyId], undefined));
  // 9999년 같은 날짜가 있어도 오늘 ±5년 안만 그린다
  const range = timelineRange(
    scheduled.map((item) => item.span),
    today,
    scale,
  );
  const visible = scheduled.filter(({ span }) => span.end >= range.start && span.start <= range.end);

  const tasks: ITask[] = useMemo(
    () =>
      visible.map(({ row, span }) => ({
        id: row.id,
        text: `${row.icon ? `${row.icon} ` : ""}${row.title || "제목 없음"}`,
        start: toLocalDate(Math.max(span.start, range.start)),
        end: toLocalDate(Math.min(span.end, range.end) + 1),
        type: "task",
        progress: 0,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(visible.map(({ row, span }) => [row.id, row.title, row.icon, span])), range.start, range.end],
  );

  // init 은 한 번만 불리므로 최신 값은 ref 로 읽는다
  const latest = useRef({ rows, onChangeDates, onOpenRow, endPropertyId });
  latest.current = { rows, onChangeDates, onOpenRow, endPropertyId };

  const init = (api: IApi) => {
    apiRef.current = api;
    // 막대 끌기·늘이기가 끝나면 데이터베이스 날짜로 저장한다
    api.on("update-task", (ev) => {
      if (ev.inProgress) return;
      const task = api.getTask(ev.id);
      const row = latest.current.rows.find((r) => r.id === ev.id);
      if (!row || !task?.start || !task.end) return;
      const start = fromDayNumber(localDay(task.start));
      // 끝 날짜 속성이 없으면 하루짜리라 시작만 옮긴다
      const end = latest.current.endPropertyId ? fromDayNumber(Math.max(localDay(task.end) - 1, localDay(task.start))) : start;
      const prevStart = row.values?.[startPropertyId];
      const prevEnd = latest.current.endPropertyId ? row.values?.[latest.current.endPropertyId] : start;
      if (start !== prevStart || end !== prevEnd) latest.current.onChangeDates(row, start, end);
    });
    // SVAR 자체 편집 창 대신 Noty 행 상세를 연다
    api.intercept("show-editor", ({ id }) => {
      const row = latest.current.rows.find((r) => r.id === id);
      if (row) latest.current.onOpenRow(row);
      return false;
    });
    // 행 추가·삭제·순서·연결선은 데이터베이스 쪽에서만 한다
    for (const action of ["add-task", "delete-task", "move-task", "copy-task", "indent-task", "add-link"] as const) {
      api.intercept(action, () => false);
    }
  };

  const scrollToToday = () => void apiRef.current?.exec("scroll-chart", { date: toLocalDate(today - (scale === "day" ? 7 : scale === "week" ? 21 : 60)) });
  useEffect(() => {
    // 처음과 단위를 바꿀 때 오늘 근처를 보여 준다 (그리기가 끝난 뒤)
    const timer = window.setTimeout(scrollToToday, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const config = SCALE_CONFIG[scale];
  // 머리글 두 줄 + 행 + 가로 스크롤바
  const height = Math.min(560, SCALE_HEIGHT * 2 + Math.max(tasks.length, 3) * ROW_HEIGHT + 20);

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
          <button type="button" onClick={scrollToToday}>
            오늘
          </button>
          <button type="button" onClick={() => onAddRow(fromDayNumber(today))}>
            + 새로 만들기
          </button>
        </div>
      </div>

      <div className="ndb-timeline__frame" style={{ height }}>
        <Willow fonts={false}>
          <Gantt
            key={scale}
            init={init}
            tasks={tasks}
            links={[]}
            columns={COLUMNS}
            scales={config.scales}
            cellWidth={config.cellWidth}
            cellHeight={ROW_HEIGHT}
            scaleHeight={SCALE_HEIGHT}
            lengthUnit="day"
            durationUnit="day"
            start={toLocalDate(range.start)}
            end={toLocalDate(range.end + 1)}
            highlightTime={(date: Date, unit: string) => {
              if (unit !== "day") return "";
              const day = localDay(date);
              if (day === today) return "ndb-timeline__today";
              return date.getDay() === 0 || date.getDay() === 6 ? "ndb-timeline__weekend" : "";
            }}
          />
        </Willow>
      </div>

      {unscheduled.length > 0 && (
        <div className="ndb-calendar__unscheduled">
          <span>날짜 없음 ({unscheduled.length})</span>
          <div className="ndb-calendar__unscheduled-list">
            {unscheduled.map((row) => (
              <button key={row.id} type="button" className="ndb-calendar__event" onClick={() => onOpenRow(row)}>
                <span>{row.icon || "📄"}</span>
                <span>{row.title || "제목 없음"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="ndb-timeline__hint">막대를 끌어 옮기고 양 끝을 끌어 기간을 바꿉니다. 두 번 누르면 상세가 열립니다.</p>
    </div>
  );
}
