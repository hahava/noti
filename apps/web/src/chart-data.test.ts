import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionProperty, CollectionRow } from "@noty/shared/collection-types";
import { buildChart, CHART_NEUTRAL } from "./chart-data";

const done: CollectionProperty = { id: "done", name: "완료", type: "checkbox" };
const due: CollectionProperty = { id: "due", name: "날짜", type: "date" };
const status: CollectionProperty = { id: "st", name: "상태", type: "select", options: ["할 일", "완료"], optionColors: { 완료: "green" } };
const points: CollectionProperty = { id: "pt", name: "점수", type: "number" };
const tags: CollectionProperty = { id: "tg", name: "태그", type: "multi_select", options: ["a", "b"] };
const valueOf = (row: CollectionRow, p: CollectionProperty) => row.values?.[p.id] ?? "";
const row = (id: string, values: CollectionRow["values"]): CollectionRow => ({ id, title: id, values });

const rows = [
  row("1", { done: true, due: "2026-11-16", st: "완료", pt: "3", tg: "a\u001fb" }),
  row("2", { done: false, due: "2026-11-18", st: "할 일", pt: "5", tg: "a" }),
  row("3", { done: true, due: "2026-11-30", st: "", pt: "x" }),
  row("4", { done: false, st: "기타값" }),
];

test("chart: weekly completion rate fills empty weeks and skips undated rows", () => {
  const chart = buildChart(rows, { groupBy: due, aggregate: "percent_checked", valueProperty: done, dateBucket: "week" }, valueOf);
  assert.deepEqual(chart.data.map((p) => [p.label, p.value]), [["11/16주", 50], ["11/23주", 0], ["11/30주", 100]]);
  assert.equal(chart.skipped, 1);
  assert.equal(chart.total, 50);
});

test("chart: select groups keep option order and colors, empty last", () => {
  const chart = buildChart(rows, { groupBy: status, aggregate: "count", dateBucket: "week" }, valueOf);
  assert.deepEqual(chart.groups.map((g) => g.label), ["할 일", "완료", "기타값", "비어 있음"]);
  assert.equal(chart.groups[1].color, "#1baf7a");
  assert.equal(chart.groups[3].color, CHART_NEUTRAL);
});

test("chart: series split, sums, multi-select and folding into 기타", () => {
  const stacked = buildChart(rows, { groupBy: status, seriesBy: done, aggregate: "count", dateBucket: "week" }, valueOf);
  assert.deepEqual(stacked.series.map((s) => s.label), ["체크됨", "체크 안 됨"]);
  assert.deepEqual(stacked.data[1], { label: "완료", key: "완료", "s:true": 1, "s:false": 0 });
  assert.equal(buildChart(rows, { aggregate: "sum", valueProperty: points, dateBucket: "week" }, valueOf).total, 8, "non-numbers ignored");
  const tagged = buildChart(rows, { groupBy: tags, aggregate: "count", dateBucket: "week" }, valueOf);
  assert.deepEqual(tagged.data.map((p) => [p.label, p.value]), [["a", 2], ["b", 1], ["비어 있음", 2]]);
  const folded = buildChart(rows, { groupBy: status, aggregate: "count", dateBucket: "week", maxGroups: 2 }, valueOf);
  assert.deepEqual(folded.data.map((p) => [p.label, p.value]), [["할 일", 1], ["기타", 3]]);
});
