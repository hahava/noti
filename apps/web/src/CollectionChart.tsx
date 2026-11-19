import { useMemo } from "react";
import { EChart, type EChartOption } from "./EChart";
import type { CollectionProperty, CollectionRow, CollectionView } from "@noty/shared/collection-types";
import { buildChart, type ChartAggregate, type ChartType } from "./chart-data";

const TYPES: Array<{ type: ChartType; label: string }> = [
  { type: "bar", label: "막대" },
  { type: "line", label: "선" },
  { type: "donut", label: "도넛" },
  { type: "number", label: "숫자" },
];
const GROUPABLE = new Set(["select", "status", "multi_select", "checkbox", "date", "text", "url", "email", "phone", "relation", "formula", "rollup", "number"]);
const INK = "#37352f";
const MUTED = "#9b9a97";
const HAIRLINE = "#ededeb";
const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", "Segoe UI", sans-serif';

/** 색을 투명도와 섞는다 (선 아래 그라데이션용) */
const alpha = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;

interface Props {
  rows: CollectionRow[];
  properties: CollectionProperty[];
  view: CollectionView;
  valueOf: (row: CollectionRow, property: CollectionProperty) => unknown;
  onChangeView: (patch: Partial<CollectionView>) => void;
}

/** 노션 차트 뷰처럼: 속성으로 묶고 개수·합계·평균·체크 비율을 막대·선·도넛·숫자로 본다 */
export function CollectionChart({ rows, properties, view, valueOf, onChangeView }: Props) {
  const type = view.chartType ?? "bar";
  const aggregate: ChartAggregate = view.chartAggregate ?? "count";
  const byId = (id?: string) => properties.find((property) => property.id === id);
  const groupBy = type === "number" ? undefined : byId(view.chartGroupBy);
  const seriesBy = type === "bar" || type === "line" ? byId(view.chartSeriesBy) : undefined;
  const valueProperty = byId(view.chartValuePropertyId);
  const dateBucket = view.chartDateBucket ?? "week";
  const percent = aggregate === "percent_checked";

  const chart = useMemo(
    () =>
      buildChart(
        rows,
        { groupBy, seriesBy: seriesBy?.id === groupBy?.id ? undefined : seriesBy, aggregate, valueProperty, dateBucket, maxGroups: type === "donut" ? 6 : undefined },
        valueOf,
      ),
    [rows, groupBy, seriesBy, aggregate, valueProperty, dateBucket, type, valueOf],
  );

  const format = (value: unknown) => (percent ? `${value}%` : Number(value).toLocaleString("ko-KR"));
  const measureLabel =
    aggregate === "count" || !valueProperty
      ? "개수"
      : `${valueProperty.name} ${{ sum: "합계", average: "평균", percent_checked: "체크 비율", count: "" }[aggregate]}`;
  // 옵션이 매 렌더마다 새로 생기면 차트가 다시 애니메이션되므로 묶어 둔다
  const series = useMemo(
    () => chart.series.map((item) => (item.key === "value" ? { ...item, label: measureLabel } : item)),
    [chart, measureLabel],
  );
  const valueChoices = [
    { value: "count:", label: "개수" },
    ...properties.flatMap((property) =>
      property.type === "number" || property.type === "formula" || property.type === "rollup"
        ? [
            { value: `sum:${property.id}`, label: `${property.name} 합계` },
            { value: `average:${property.id}`, label: `${property.name} 평균` },
          ]
        : property.type === "checkbox"
          ? [{ value: `percent_checked:${property.id}`, label: `${property.name} 체크 비율 (%)` }]
          : [],
    ),
  ];
  const groupChoices = properties.filter((property) => GROUPABLE.has(property.type));
  const option = useMemo(
    () => (groupBy && type !== "number" ? chartOption(type, chart, series, percent, aggregate === "count") : null),
    [groupBy, type, chart, percent, aggregate, series],
  );

  return (
    <div className="ndb-chart">
      <div className="ndb-chart__bar">
        <div className="ndb-timeline__scales" role="group" aria-label="차트 모양">
          {TYPES.map((item) => (
            <button key={item.type} type="button" aria-pressed={type === item.type} onClick={() => onChangeView({ chartType: item.type })}>
              {item.label}
            </button>
          ))}
        </div>
        {type !== "number" && (
          <label className="ndb-chart__field">
            {type === "donut" ? "나눌 속성" : "가로축"}
            <select value={groupBy?.id ?? ""} onChange={(event) => onChangeView({ chartGroupBy: event.target.value || undefined })}>
              <option value="">선택하세요</option>
              {groupChoices.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {groupBy?.type === "date" && (
          <label className="ndb-chart__field">
            단위
            <select value={dateBucket} onChange={(event) => onChangeView({ chartDateBucket: event.target.value as CollectionView["chartDateBucket"] })}>
              <option value="day">일</option>
              <option value="week">주</option>
              <option value="month">월</option>
            </select>
          </label>
        )}
        <label className="ndb-chart__field">
          값
          <select
            value={`${valueProperty ? aggregate : "count"}:${valueProperty && aggregate !== "count" ? valueProperty.id : ""}`}
            onChange={(event) => {
              const [nextAggregate, propertyId] = event.target.value.split(":");
              onChangeView({ chartAggregate: nextAggregate as ChartAggregate, chartValuePropertyId: propertyId || undefined });
            }}
          >
            {valueChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {(type === "bar" || type === "line") && (
          <label className="ndb-chart__field">
            색으로 나누기
            <select value={seriesBy?.id ?? ""} onChange={(event) => onChangeView({ chartSeriesBy: event.target.value || undefined })}>
              <option value="">없음</option>
              {groupChoices
                .filter((property) => property.type !== "date" && property.id !== groupBy?.id)
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      {type === "number" ? (
        <div className="ndb-chart__number">
          <strong>{format(chart.total)}</strong>
          <span>
            {measureLabel} · 항목 {rows.length}개
          </span>
        </div>
      ) : !groupBy ? (
        <div className="ndb-empty-state">
          <p>무엇으로 묶어 볼지 {type === "donut" ? "나눌 속성" : "가로축"}을 고르세요.</p>
        </div>
      ) : chart.data.length === 0 ? (
        <div className="ndb-empty-state">
          <p>표시할 항목이 없습니다.</p>
        </div>
      ) : (
        <div className="ndb-chart__plot" role="img" aria-label={`${groupBy.name}별 ${measureLabel} 차트`}>
          {option && <EChart option={option} height={300} />}
          {type === "donut" && (
            <div className="ndb-chart__center" aria-hidden>
              <strong>{format(chart.total)}</strong>
              <span>{measureLabel}</span>
            </div>
          )}
        </div>
      )}

      {groupBy && chart.data.length > 0 && type !== "number" && (
        <details className="ndb-chart__table">
          <summary>
            표로 보기{chart.skipped > 0 ? ` · 날짜가 없어 빠진 항목 ${chart.skipped}개` : ""}
          </summary>
          <table>
            <thead>
              <tr>
                <th>{groupBy.name}</th>
                {series.map((item) => (
                  <th key={item.key}>{item.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.data.map((point) => (
                <tr key={String(point.key)}>
                  <td>{point.label}</td>
                  {series.map((item) => (
                    <td key={item.key}>{format(point[item.key] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

type Series = Array<{ key: string; label: string; color: string }>;

function chartOption(type: ChartType, chart: ReturnType<typeof buildChart>, series: Series, percent: boolean, integer: boolean): EChartOption {
  const format = (value: unknown) => (percent ? `${value}%` : Number(value).toLocaleString("ko-KR"));
  const base: EChartOption = {
    animationDuration: 450,
    animationDurationUpdate: 350,
    animationEasing: "cubicOut",
    textStyle: { fontFamily: FONT, color: INK },
    tooltip: {
      trigger: type === "donut" ? "item" : "axis",
      backgroundColor: "#fff",
      borderColor: "#e9e9e7",
      borderWidth: 1,
      borderRadius: 8,
      padding: [8, 12],
      extraCssText: "box-shadow: 0 6px 20px rgba(15,15,15,0.10);",
      textStyle: { color: INK, fontSize: 12.5, fontFamily: FONT },
      valueFormatter: (value) => format(value),
      axisPointer: type === "bar" ? { type: "shadow", shadowStyle: { color: "rgba(55,53,47,0.04)" } } : { type: "line", lineStyle: { color: "#d9d8d4", type: "dashed" } },
    },
    legend: {
      // 시리즈가 하나면 범례 대신 제목(값 이름)이 알려 준다
      show: type === "donut" || series.length > 1,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: INK, fontSize: 12.5 },
      ...(type === "donut" ? { orient: "vertical", right: 8, top: "middle" } : { bottom: 0, left: "center" }),
    },
  };

  if (type === "donut") {
    return {
      ...base,
      series: [
        {
          type: "pie",
          radius: ["60%", "84%"],
          center: ["42%", "50%"],
          padAngle: 1.5,
          itemStyle: { borderRadius: 6 },
          label: { show: false },
          emphasis: { scale: true, scaleSize: 4 },
          data: chart.data.map((point, index) => ({
            name: String(point.label),
            value: Number(point.value),
            itemStyle: { color: chart.groups[index].color },
          })),
        },
      ],
    };
  }

  const many = chart.data.length > 24;
  const stacked = type === "bar" && series.length > 1 && !percent;
  return {
    ...base,
    grid: { left: 4, right: 12, top: 16, bottom: series.length > 1 ? 32 : 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    xAxis: {
      type: "category",
      data: chart.data.map((point) => String(point.label)),
      boundaryGap: type === "bar",
      axisLine: { lineStyle: { color: "#e3e2e0" } },
      axisTick: { show: false },
      axisLabel: { color: MUTED, fontSize: 12, hideOverlap: true, margin: 10 },
    },
    yAxis: {
      type: "value",
      max: percent ? 100 : undefined,
      minInterval: integer ? 1 : undefined,
      ...(percent ? { interval: 25 } : { splitNumber: 4 }),
      splitLine: { lineStyle: { color: HAIRLINE, type: [4, 4] } },
      axisLabel: { color: MUTED, fontSize: 12, formatter: percent ? "{value}%" : undefined },
    },
    series: series.map((item, index) =>
      type === "line"
        ? {
            type: "line" as const,
            name: item.label,
            data: chart.data.map((point) => Number(point[item.key] ?? 0)),
            smooth: 0.35,
            symbol: "circle",
            symbolSize: 7,
            showSymbol: !many,
            lineStyle: { width: 2.5, color: item.color },
            itemStyle: { color: item.color, borderColor: "#fff", borderWidth: 2 },
            // 선이 하나일 때만 아래를 옅게 채운다 (여럿이면 겹쳐서 탁해짐)
            areaStyle:
              series.length === 1
                ? { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(item.color, 0.22) }, { offset: 1, color: alpha(item.color, 0) }] } }
                : undefined,
            emphasis: { focus: "series" },
          }
        : {
            type: "bar" as const,
            name: item.label,
            data: chart.data.map((point) => Number(point[item.key] ?? 0)),
            stack: stacked ? "total" : undefined,
            barMaxWidth: 36,
            barGap: "20%",
            // 쌓은 막대는 맨 위 조각만, 나란한 막대는 각각 위쪽 모서리를 둥글게
            itemStyle: {
              color: item.color,
              borderRadius: !stacked || index === series.length - 1 ? [5, 5, 0, 0] : 0,
              ...(stacked ? { borderColor: "#fff", borderWidth: 1 } : {}),
            },
            emphasis: { focus: "series" },
          },
    ),
  };
}
