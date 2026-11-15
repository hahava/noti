import assert from "node:assert/strict";
import test from "node:test";
import { dragSpan, fromDayNumber, headerGroups, headerTicks, rowSpan, timelineRange, toDayNumber } from "./timeline";

test("timeline: day numbers round-trip and spans", () => {
  const d = toDayNumber("2026-03-29")!;
  assert.equal(fromDayNumber(d), "2026-03-29");
  assert.equal(fromDayNumber(d + 3), "2026-04-01");
  assert.equal(toDayNumber(""), null);
  assert.deepEqual(rowSpan("2026-03-29", ""), { start: d, end: d });
  assert.deepEqual(rowSpan("2026-03-29", "2026-03-01"), { start: d, end: d }, "end before start → one day");
  assert.deepEqual(rowSpan("2026-03-29", "2026-04-01"), { start: d, end: d + 3 });
  assert.equal(rowSpan(undefined, "2026-04-01"), null);
});

test("timeline: dragging keeps end >= start", () => {
  const span = { start: 10, end: 14 };
  assert.deepEqual(dragSpan(span, "move", -3), { start: 7, end: 11 });
  assert.deepEqual(dragSpan(span, "start", 10), { start: 14, end: 14 });
  assert.deepEqual(dragSpan(span, "end", -10), { start: 10, end: 10 });
  assert.deepEqual(dragSpan(span, "end", 2), { start: 10, end: 16 });
});

test("timeline: range and headers", () => {
  const today = toDayNumber("2026-11-16")!;
  const range = timelineRange([{ start: today - 40, end: today - 30 }], today, "month");
  assert.equal(fromDayNumber(range.start).slice(8), "01", "range starts on the 1st");
  assert.equal(fromDayNumber(timelineRange([], today, "day").start).slice(8), "01");
  assert.ok(range.end > today);
  const wild = timelineRange([{ start: toDayNumber("0001-01-01")!, end: toDayNumber("9999-12-31")! }], today, "day");
  assert.ok(wild.end - wild.start < 11 * 366, "extreme dates are clamped to ±5 years");
  const week = { start: toDayNumber("2026-11-16")!, end: toDayNumber("2026-11-30")! };
  assert.deepEqual(headerTicks(week, "week").map((t) => t.label), ["11/16", "11/23", "11/30"]);
  assert.deepEqual(headerGroups({ start: toDayNumber("2026-11-30")!, end: toDayNumber("2026-12-02")! }, "day"), [
    { day: toDayNumber("2026-11-30")!, days: 1, label: "2026년 11월" },
    { day: toDayNumber("2026-12-01")!, days: 2, label: "2026년 12월" },
  ]);
});
