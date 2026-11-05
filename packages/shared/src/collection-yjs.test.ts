import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import {
  collectionMap,
  editCollectionCellText,
  editCollectionRowText,
  initializeCollectionMap,
  patchCollectionMap,
  readCollectionMap,
} from "./collection-yjs";
import type { CollectionData } from "./collection-types";
import { createDefaultCollectionData, migrateLegacyCollectionData, MULTI_VALUE_SEPARATOR } from "./collection-schema";

const initial: CollectionData = {
  title: "작업",
  activeViewId: "table",
  views: [{
    id: "table", name: "전체", mode: "table", statusFilter: "all",
    tagFilter: "all", sortBy: "manual", sortDirection: "asc", hideCompleted: false,
  }],
  tagOptions: [],
  properties: [],
  rows: [
    { id: "a", title: "첫째", status: "todo", tags: [], date: "", checked: false, text: "" },
    { id: "b", title: "둘째", status: "todo", tags: [], date: "", checked: false, text: "" },
  ],
};

function pair() {
  const left = new Y.Doc();
  const leftMap = collectionMap(left, "block-1");
  initializeCollectionMap(leftMap, initial);
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const rightMap = collectionMap(right, "block-1");
  return { left, right, leftMap, rightMap };
}

function merge(left: Y.Doc, right: Y.Doc) {
  const leftState = Y.encodeStateAsUpdate(left);
  const rightState = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightState);
  Y.applyUpdate(right, leftState);
}

test("concurrent edits to different rows survive on both clients", () => {
  const { left, right, leftMap, rightMap } = pair();
  const a = readCollectionMap(leftMap)!;
  const b = readCollectionMap(rightMap)!;
  patchCollectionMap(leftMap, a, {
    ...a, rows: a.rows.map((row) => row.id === "a" ? { ...row, title: "첫째 수정" } : row),
  });
  patchCollectionMap(rightMap, b, {
    ...b, rows: b.rows.map((row) => row.id === "b" ? { ...row, title: "둘째 수정" } : row),
  });
  merge(left, right);
  assert.deepEqual(readCollectionMap(leftMap), readCollectionMap(rightMap));
  assert.deepEqual(readCollectionMap(leftMap)!.rows.map((row) => row.title), ["첫째 수정", "둘째 수정"]);
});

test("concurrent row additions keep both rows", () => {
  const { left, right, leftMap, rightMap } = pair();
  const a = readCollectionMap(leftMap)!;
  const b = readCollectionMap(rightMap)!;
  patchCollectionMap(leftMap, a, {
    ...a, rows: [...a.rows, { ...a.rows[0], id: "new-a", title: "A" }],
  });
  patchCollectionMap(rightMap, b, {
    ...b, rows: [...b.rows, { ...b.rows[0], id: "new-b", title: "B" }],
  });
  merge(left, right);
  assert.deepEqual(new Set(readCollectionMap(leftMap)!.rows.map((row) => row.id)), new Set(["a", "b", "new-a", "new-b"]));
  assert.deepEqual(readCollectionMap(leftMap), readCollectionMap(rightMap));
});

test("concurrent typing in one cell keeps both insertions", () => {
  const { left, right, leftMap, rightMap } = pair();
  const a = readCollectionMap(leftMap)!;
  const b = readCollectionMap(rightMap)!;
  patchCollectionMap(leftMap, a, {
    ...a, rows: a.rows.map((row) => row.id === "a" ? { ...row, title: "첫째 A" } : row),
  });
  patchCollectionMap(rightMap, b, {
    ...b, rows: b.rows.map((row) => row.id === "a" ? { ...row, title: "첫째 B" } : row),
  });
  merge(left, right);
  const title = readCollectionMap(leftMap)!.rows[0].title;
  assert.ok(title.includes("A") && title.includes("B"), title);
  assert.deepEqual(readCollectionMap(leftMap), readCollectionMap(rightMap));
});

test("direct cell edits merge concurrent typing across clients", () => {
  const { left, right, leftMap, rightMap } = pair();
  const data = readCollectionMap(leftMap)!;
  patchCollectionMap(leftMap, data, {
    ...data,
    properties: [{ id: "memo", name: "메모", type: "text" }],
  });
  merge(left, right);
  const before = readCollectionMap(leftMap)!.rows[0].title;
  editCollectionRowText(leftMap, "a", "title", before, `${before} A`);
  editCollectionRowText(rightMap, "a", "title", before, `${before} B`);
  editCollectionCellText(leftMap, "a", "memo", "", "왼쪽");
  editCollectionCellText(rightMap, "a", "memo", "", "오른쪽");
  merge(left, right);
  const row = readCollectionMap(leftMap)!.rows[0];
  assert.ok(row.title.includes("A") && row.title.includes("B"), row.title);
  assert.ok(String(row.values?.memo).includes("왼쪽") && String(row.values?.memo).includes("오른쪽"));
  assert.deepEqual(readCollectionMap(leftMap), readCollectionMap(rightMap));
});

test("a new custom property and its cell value persist in Yjs", () => {
  const { left, leftMap } = pair();
  const data = readCollectionMap(leftMap)!;
  patchCollectionMap(leftMap, data, {
    ...data,
    properties: [{ id: "priority", name: "우선순위", type: "select", options: ["높음", "낮음"] }],
    rows: data.rows.map((row) => row.id === "a" ? { ...row, values: { priority: "높음" } } : row),
  });
  const restored = new Y.Doc();
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(left));
  const result = readCollectionMap(collectionMap(restored, "block-1"))!;
  assert.equal(result.properties[0].name, "우선순위");
  assert.equal(result.rows[0].values?.priority, "높음");
});

test("manual row order is shared without changing cell values", () => {
  const { left, right, leftMap, rightMap } = pair();
  const data = readCollectionMap(leftMap)!;
  patchCollectionMap(leftMap, data, { ...data, rows: [...data.rows].reverse() });
  merge(left, right);
  assert.deepEqual(readCollectionMap(rightMap)!.rows.map((row) => row.id), ["b", "a"]);
  assert.deepEqual(readCollectionMap(rightMap)!.rows.map((row) => row.title), ["둘째", "첫째"]);
});

test("new collections start clean with no example properties or rows", () => {
  const data = createDefaultCollectionData();
  assert.equal(data.schemaVersion, 2);
  assert.deepEqual(data.properties, []);
  assert.deepEqual(data.rows, []);
  assert.deepEqual(data.views.map((view) => view.mode), ["table"]);
  const doc = new Y.Doc();
  const map = collectionMap(doc, "new");
  initializeCollectionMap(map, data);
  const current = readCollectionMap(map)!;
  patchCollectionMap(map, current, {
    ...current,
    rows: [{ id: "new-row", title: "새 항목", values: {} }],
  });
  const row = readCollectionMap(map)!.rows[0];
  assert.equal(row.title, "새 항목");
  assert.equal(row.status, undefined);
  assert.equal(row.date, undefined);
  assert.equal(row.text, undefined);
});

test("legacy fixed fields become editable properties without losing values", () => {
  const old: CollectionData = {
    ...initial,
    views: [...initial.views, { ...initial.views[0], id: "board", mode: "board", name: "보드" }, { ...initial.views[0], id: "calendar", mode: "calendar", name: "달력" }],
    tagOptions: [{ id: "t1", label: "중요", color: "amber" }, { id: "t2", label: "기획", color: "purple" }],
    rows: [{ ...initial.rows[0], status: "done", tags: ["t1", "t2"], date: "2026-10-30", checked: true, text: "기존 메모" }],
  };
  const doc = new Y.Doc();
  const map = collectionMap(doc, "legacy");
  initializeCollectionMap(map, old);
  map.delete("schemaVersion");
  initializeCollectionMap(map, createDefaultCollectionData());
  const result = readCollectionMap(map)!;
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.rows[0].values?.["legacy-status"], "완료");
  assert.equal(result.rows[0].values?.["legacy-tags"], ["중요", "기획"].join(MULTI_VALUE_SEPARATOR));
  assert.equal(result.rows[0].values?.["legacy-date"], "2026-10-30");
  assert.equal(result.rows[0].values?.["legacy-checked"], true);
  assert.equal(result.rows[0].values?.["legacy-text"], "기존 메모");
  assert.equal(result.rows[0].status, undefined);
  assert.equal(result.rows[0].tags, undefined);
  assert.equal(result.rows[0].date, undefined);
  assert.equal(result.views[1].groupBy, "legacy-status");
  assert.equal(result.views[2].datePropertyId, "legacy-date");
  assert.equal(migrateLegacyCollectionData(result), result);
});

test("optionColors, width, calculation, row icon, view peekMode/collapsedGroups and templates merge in Yjs", () => {
  const { left, right, leftMap, rightMap } = pair();
  const base = readCollectionMap(leftMap)!;
  patchCollectionMap(leftMap, base, {
    ...base,
    properties: [{
      id: "status",
      name: "상태",
      type: "status",
      options: ["시작 전", "완료"],
      optionColors: { "시작 전": "gray", "완료": "green" },
      width: 210,
      calculation: "count_values",
    }],
    templates: [{
      id: "tpl-1",
      name: "주간 업무",
      icon: "🚀",
      defaultTitle: "주간 업무 보고",
      values: { status: "시작 전" },
    }],
  });
  merge(left, right);

  const lData = readCollectionMap(leftMap)!;
  const rData = readCollectionMap(rightMap)!;

  // Client A updates row 'a' icon & optionColor for '시작 전'
  patchCollectionMap(leftMap, lData, {
    ...lData,
    properties: lData.properties.map((p) => ({
      ...p,
      optionColors: { ...p.optionColors, "시작 전": "blue" },
    })),
    rows: lData.rows.map((r) => (r.id === "a" ? { ...r, icon: "🔥" } : r)),
  });

  // Client B updates view peekMode, collapsedGroups & optionColor for '완료'
  patchCollectionMap(rightMap, rData, {
    ...rData,
    properties: rData.properties.map((p) => ({
      ...p,
      optionColors: { ...p.optionColors, "완료": "amber" },
    })),
    views: rData.views.map((v) => ({
      ...v,
      peekMode: "side",
      collapsedGroups: ["시작 전"],
    })),
  });

  merge(left, right);
  const merged = readCollectionMap(leftMap)!;
  assert.deepEqual(merged, readCollectionMap(rightMap));
  assert.deepEqual(merged.properties[0].optionColors, { "시작 전": "blue", "완료": "amber" });
  assert.equal(merged.properties[0].width, 210);
  assert.equal(merged.properties[0].calculation, "count_values");
  assert.equal(merged.rows[0].icon, "🔥");
  assert.equal(merged.views[0].peekMode, "side");
  assert.deepEqual(merged.views[0].collapsedGroups, ["시작 전"]);
  assert.equal(merged.templates?.[0].name, "주간 업무");
  assert.equal(merged.templates?.[0].icon, "🚀");
});

test("view and property horizontal width settings sync and reset cleanly in Yjs", () => {
  const { left, right, leftMap, rightMap } = pair();
  const base = readCollectionMap(leftMap)!;
  patchCollectionMap(leftMap, base, {
    ...base,
    properties: [{ id: "col-1", name: "담당자", type: "text", width: 220 }],
    views: base.views.map((v) => ({
      ...v,
      titleWidth: 340,
      boardColumnWidth: 300,
      galleryCardWidth: 280,
      peekWidth: 720,
      peekLabelWidth: 190,
    })),
  });
  merge(left, right);

  const synced = readCollectionMap(rightMap)!;
  assert.equal(synced.properties[0].width, 220);
  assert.equal(synced.views[0].titleWidth, 340);
  assert.equal(synced.views[0].boardColumnWidth, 300);
  assert.equal(synced.views[0].galleryCardWidth, 280);
  assert.equal(synced.views[0].peekWidth, 720);
  assert.equal(synced.views[0].peekLabelWidth, 190);

  // Resetting widths back to undefined removes them cleanly on both peers
  patchCollectionMap(rightMap, synced, {
    ...synced,
    properties: synced.properties.map((p) => ({ ...p, width: undefined })),
    views: synced.views.map((v) => ({
      ...v,
      titleWidth: undefined,
      boardColumnWidth: undefined,
      galleryCardWidth: undefined,
      peekWidth: undefined,
      peekLabelWidth: undefined,
    })),
  });
  merge(left, right);

  const reset = readCollectionMap(leftMap)!;
  assert.equal(reset.properties[0].width, undefined);
  assert.equal(reset.views[0].titleWidth, undefined);
  assert.equal(reset.views[0].boardColumnWidth, undefined);
  assert.equal(reset.views[0].galleryCardWidth, undefined);
  assert.equal(reset.views[0].peekWidth, undefined);
  assert.equal(reset.views[0].peekLabelWidth, undefined);
});


