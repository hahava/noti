/** 컬렉션 차트 뷰의 집계. 렌더링(Recharts)과 분리해 테스트한다. */
import type { CollectionOptionColor, CollectionProperty, CollectionRow, CollectionView } from "@noty/shared/collection-types";
import { MULTI_VALUE_SEPARATOR } from "@noty/shared/collection-schema";
import { fromDayNumber, toDayNumber } from "./timeline";

export type ChartType = NonNullable<CollectionView["chartType"]>;
export type ChartAggregate = NonNullable<CollectionView["chartAggregate"]>;
export type ChartDateBucket = NonNullable<CollectionView["chartDateBucket"]>;

/** 검증한 범주 색 순서 (dataviz validate_palette 통과). 회색은 "비어 있음·기타" 전용. */
export const CHART_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#6250d6", "#e87ba4"];
export const CHART_NEUTRAL = "#a3a29e";
const OPTION_HEX: Record<CollectionOptionColor, string> = {
  blue: "#2a78d6",
  amber: "#eda100",
  green: "#1baf7a",
  purple: "#6250d6",
  rose: "#e87ba4",
  gray: CHART_NEUTRAL,
};

const EMPTY = "";
const OTHER = "\u0000other";
const MAX_GROUPS = 30;
const MAX_DATE_BUCKETS = 400;

export interface ChartEntry {
  key: string;
  label: string;
  color: string;
}

export interface ChartResult {
  groups: ChartEntry[];
  series: ChartEntry[];
  /** groups 순서. 각 항목은 { label, [series.key]: 값 } */
  data: Array<Record<string, string | number>>;
  /** 행 전체에 대한 집계값 (숫자 카드·도넛 가운데) */
  total: number;
  /** 날짜로 묶을 때 날짜가 없어 빠진 행 수 */
  skipped: number;
}

export interface ChartConfig {
  groupBy?: CollectionProperty;
  seriesBy?: CollectionProperty;
  aggregate: ChartAggregate;
  valueProperty?: CollectionProperty;
  dateBucket: ChartDateBucket;
  /** 도넛은 조각이 많으면 읽을 수 없어 5개 + 기타로 접는다 */
  maxGroups?: number;
}

type ValueOf = (row: CollectionRow, property: CollectionProperty) => unknown;

const isChecked = (value: unknown) => value === true || value === "true";

function bucketOf(value: unknown, bucket: ChartDateBucket): number | null {
  const day = toDayNumber(value);
  if (day === null) return null;
  if (bucket === "day") return day;
  if (bucket === "week") return day - ((day + 3) % 7); // 1970-01-01은 목요일 → 월요일 시작
  const iso = fromDayNumber(day);
  return toDayNumber(`${iso.slice(0, 7)}-01`);
}

function nextBucket(day: number, bucket: ChartDateBucket): number {
  if (bucket === "day") return day + 1;
  if (bucket === "week") return day + 7;
  const iso = fromDayNumber(day);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return toDayNumber(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`)!;
}

function bucketLabel(day: number, bucket: ChartDateBucket, multiYear: boolean): string {
  const iso = fromDayNumber(day);
  const [y, m, d] = [iso.slice(2, 4), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
  if (bucket === "month") return multiYear ? `${y}.${m}월` : `${m}월`;
  const md = `${m}/${d}`;
  return bucket === "week" ? `${multiYear ? `${y}.` : ""}${md}주` : `${multiYear ? `${y}.` : ""}${md}`;
}

/** 행이 속하는 묶음 키들 (다중 선택은 여러 개) */
function keysOf(row: CollectionRow, property: CollectionProperty, valueOf: ValueOf, bucket: ChartDateBucket): string[] {
  const value = valueOf(row, property);
  if (property.type === "checkbox") return [isChecked(value) ? "true" : "false"];
  if (property.type === "date") {
    const day = bucketOf(value, bucket);
    return day === null ? [] : [String(day)];
  }
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (property.type === "multi_select") {
    const parts = text.split(MULTI_VALUE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts : [EMPTY];
  }
  return [text];
}

function labelOf(property: CollectionProperty | undefined, key: string, bucket: ChartDateBucket, multiYear: boolean): string {
  if (key === OTHER) return "기타";
  if (!property) return "전체";
  if (property.type === "checkbox") return key === "true" ? "체크됨" : "체크 안 됨";
  if (key === EMPTY) return "비어 있음";
  if (property.type === "date") return bucketLabel(Number(key), bucket, multiYear);
  return key;
}

/** 색은 순위가 아니라 값에 붙는다: 선택지 색 → 체크박스 고정색 → 순서대로 */
function colorize(property: CollectionProperty | undefined, keys: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  let next = 0;
  for (const key of keys) {
    const option = property?.optionColors?.[key];
    if (key === EMPTY || key === OTHER) colors.set(key, CHART_NEUTRAL);
    else if (property?.type === "checkbox") colors.set(key, key === "true" ? OPTION_HEX.green : CHART_NEUTRAL);
    else if (option) colors.set(key, OPTION_HEX[option]);
    else colors.set(key, CHART_COLORS[next++ % CHART_COLORS.length]);
  }
  return colors;
}

function measure(rows: CollectionRow[], config: ChartConfig, valueOf: ValueOf): number {
  const { aggregate, valueProperty } = config;
  if (aggregate === "count" || !valueProperty) return rows.length;
  if (aggregate === "percent_checked") {
    if (!rows.length) return 0;
    const done = rows.filter((row) => isChecked(valueOf(row, valueProperty))).length;
    return Math.round((done / rows.length) * 1000) / 10;
  }
  const numbers = rows
    .map((row) => valueOf(row, valueProperty))
    .filter((value) => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  const sum = numbers.reduce((total, value) => total + value, 0);
  if (aggregate === "sum") return Math.round(sum * 100) / 100;
  return numbers.length ? Math.round((sum / numbers.length) * 100) / 100 : 0;
}

/** 묶음 순서: 선택지 순서·체크됨 먼저·날짜순(빈 칸 채움)·그 밖은 많은 순 */
function orderKeys(
  property: CollectionProperty | undefined,
  buckets: Map<string, CollectionRow[]>,
  bucket: ChartDateBucket,
  limit: number,
): { keys: string[]; folded: Map<string, string> } {
  const folded = new Map<string, string>();
  let keys = [...buckets.keys()];
  if (!property) return { keys, folded };
  if (property.type === "date") {
    const days = keys.map(Number).sort((a, b) => a - b);
    if (!days.length) return { keys: [], folded };
    const filled: string[] = [];
    for (let day = days[0]; day <= days[days.length - 1] && filled.length < MAX_DATE_BUCKETS; day = nextBucket(day, bucket)) {
      filled.push(String(day));
    }
    return { keys: filled, folded };
  }
  if (property.type === "checkbox") return { keys: ["true", "false"], folded };
  const options = property.type === "select" || property.type === "status" || property.type === "multi_select" ? property.options ?? [] : [];
  const rank = (key: string) => (key === EMPTY ? Infinity : options.includes(key) ? options.indexOf(key) : options.length);
  keys.sort((a, b) => rank(a) - rank(b) || (buckets.get(b)?.length ?? 0) - (buckets.get(a)?.length ?? 0) || a.localeCompare(b));
  if (keys.length > limit) {
    const kept = keys.slice(0, limit - 1);
    for (const key of keys.slice(limit - 1)) folded.set(key, OTHER);
    keys = [...kept, OTHER];
  }
  return { keys, folded };
}

function groupRows(
  rows: CollectionRow[],
  property: CollectionProperty | undefined,
  valueOf: ValueOf,
  bucket: ChartDateBucket,
): { buckets: Map<string, CollectionRow[]>; skipped: number } {
  const buckets = new Map<string, CollectionRow[]>();
  let skipped = 0;
  for (const row of rows) {
    const keys = property ? keysOf(row, property, valueOf, bucket) : ["all"];
    if (!keys.length) skipped++;
    for (const key of keys) buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return { buckets, skipped };
}

function foldBuckets(buckets: Map<string, CollectionRow[]>, folded: Map<string, string>): Map<string, CollectionRow[]> {
  if (!folded.size) return buckets;
  const result = new Map<string, CollectionRow[]>();
  for (const [key, rows] of buckets) {
    const target = folded.get(key) ?? key;
    // 다중 선택은 한 행이 여러 접힌 키에 있을 수 있어 기타에 한 번만 센다
    result.set(target, [...new Set([...(result.get(target) ?? []), ...rows])]);
  }
  return result;
}

export function buildChart(rows: CollectionRow[], config: ChartConfig, valueOf: ValueOf): ChartResult {
  const { groupBy, seriesBy, dateBucket } = config;
  const grouped = groupRows(rows, groupBy, valueOf, dateBucket);
  const groupOrder = orderKeys(groupBy, grouped.buckets, dateBucket, config.maxGroups ?? MAX_GROUPS);
  const groupBuckets = foldBuckets(grouped.buckets, groupOrder.folded);

  const days = groupBy?.type === "date" ? groupOrder.keys.map(Number) : [];
  const multiYear = days.length > 0 && fromDayNumber(days[0]).slice(0, 4) !== fromDayNumber(days[days.length - 1]).slice(0, 4);
  const groupColors = colorize(groupBy, groupOrder.keys);
  const groups = groupOrder.keys.map((key) => ({ key, label: labelOf(groupBy, key, dateBucket, multiYear), color: groupColors.get(key)! }));

  const seriesAll = seriesBy ? groupRows(rows, seriesBy, valueOf, dateBucket) : null;
  const seriesOrder = seriesAll ? orderKeys(seriesBy, seriesAll.buckets, dateBucket, CHART_COLORS.length) : null;
  const seriesColors = colorize(seriesBy, seriesOrder?.keys ?? []);
  const series: ChartEntry[] = seriesOrder
    ? seriesOrder.keys.map((key) => ({ key: `s:${key}`, label: labelOf(seriesBy, key, dateBucket, false), color: seriesColors.get(key)! }))
    : [{ key: "value", label: "값", color: CHART_COLORS[0] }];

  const data = groups.map((group) => {
    const groupRowsList = groupBuckets.get(group.key) ?? [];
    const point: Record<string, string | number> = { label: group.label, key: group.key };
    if (!seriesBy || !seriesOrder) {
      point.value = measure(groupRowsList, config, valueOf);
      return point;
    }
    const inner = foldBuckets(groupRows(groupRowsList, seriesBy, valueOf, dateBucket).buckets, seriesOrder.folded);
    for (const key of seriesOrder.keys) point[`s:${key}`] = measure(inner.get(key) ?? [], config, valueOf);
    return point;
  });

  return { groups, series, data, total: measure(rows, config, valueOf), skipped: grouped.skipped };
}
