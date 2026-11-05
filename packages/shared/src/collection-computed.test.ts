import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { computeColumnCalculation, computePropertyValue, evaluateFormula } from "./collection-computed";
import { createDefaultCollectionData, MULTI_VALUE_SEPARATOR } from "./collection-schema";
import { collectionMap, initializeCollectionMap, patchCollectionMap, readCollectionMap } from "./collection-yjs";
import type { CollectionData } from "./collection-types";

test("relation, rollup and formula values derive from linked rows", () => {
  const tasks: CollectionData = {
    ...createDefaultCollectionData("작업"), collectionId: "collection-tasks",
    properties: [{ id: "amount", name: "금액", type: "number" }],
    rows: [
      { id: "a", title: "첫 작업", values: { amount: "100" } },
      { id: "b", title: "둘째 작업", values: { amount: "250" } },
    ],
  };
  const project: CollectionData = {
    ...createDefaultCollectionData("프로젝트"), collectionId: "collection-projects",
    properties: [
      { id: "tasks", name: "작업", type: "relation", relationCollectionId: tasks.collectionId },
      { id: "total", name: "합계", type: "rollup", rollupRelationId: "tasks", rollupPropertyId: "amount", rollupFunction: "sum" },
      { id: "double", name: "두 배", type: "formula", formula: 'prop("합계") * 2' },
    ],
    rows: [{ id: "p", title: "프로젝트", values: { tasks: ["a", "b"].join(MULTI_VALUE_SEPARATOR) } }],
  };
  const [relation, rollup, formula] = project.properties;
  const linked = { [tasks.collectionId!]: tasks };
  assert.equal(computePropertyValue(project, project.rows[0], relation, linked), "첫 작업, 둘째 작업");
  assert.equal(computePropertyValue(project, project.rows[0], rollup, linked), 350);
  assert.equal(computePropertyValue(project, project.rows[0], formula, linked), 700);
});

test("formulas reject invalid syntax and detect property cycles", () => {
  assert.equal(evaluateFormula('if(prop("완료") == true, "끝", "진행")', (name) => name === "완료"), "끝");
  assert.equal(evaluateFormula('round(10 / 3, 2)', () => ""), 3.33);
  assert.equal(evaluateFormula("globalThis.secret", () => ""), "#ERROR");
  const data: CollectionData = {
    ...createDefaultCollectionData(), collectionId: "collection-cycle",
    properties: [{ id: "a", name: "A", type: "formula", formula: 'prop("B")' }, { id: "b", name: "B", type: "formula", formula: 'prop("A")' }],
    rows: [{ id: "r", title: "순환", values: {} }],
  };
  assert.equal(computePropertyValue(data, data.rows[0], data.properties[0]), "#CYCLE");
});

test("relation settings and view filters persist through Yjs", () => {
  const doc = new Y.Doc();
  const map = collectionMap(doc, "collection-view");
  const initial = createDefaultCollectionData();
  initializeCollectionMap(map, initial);
  const next: CollectionData = {
    ...initial,
    properties: [{ id: "relation", name: "관계", type: "relation", relationCollectionId: "collection-target" }],
    views: [{ ...initial.views[0], hiddenPropertyIds: ["relation"], filterMode: "or", filters: [{ propertyId: "title", operator: "contains", value: "실험" }] }],
  };
  patchCollectionMap(map, readCollectionMap(map)!, next);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
  const result = readCollectionMap(collectionMap(restored, "collection-view"))!;
  assert.equal(result.properties[0].relationCollectionId, "collection-target");
  assert.deepEqual(result.views[0].hiddenPropertyIds, ["relation"]);
  assert.deepEqual(result.views[0].filters, [{ propertyId: "title", operator: "contains", value: "실험" }]);
});

test("concurrent relation selections keep both linked rows", () => {
  const initial: CollectionData = {
    ...createDefaultCollectionData(),
    properties: [{ id: "rel", name: "관계", type: "relation", relationCollectionId: "collection-target" }],
    rows: [{ id: "r", title: "행", values: {} }],
  };
  const left = new Y.Doc();
  const leftMap = collectionMap(left, "collection-source");
  initializeCollectionMap(leftMap, initial);
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const rightMap = collectionMap(right, "collection-source");
  const first = readCollectionMap(leftMap)!;
  const second = readCollectionMap(rightMap)!;
  patchCollectionMap(leftMap, first, { ...first, rows: [{ ...first.rows[0], values: { rel: "a" } }] });
  patchCollectionMap(rightMap, second, { ...second, rows: [{ ...second.rows[0], values: { rel: "b" } }] });
  const leftState = Y.encodeStateAsUpdate(left);
  const rightState = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightState);
  Y.applyUpdate(right, leftState);
  const linked = readCollectionMap(leftMap)!.rows[0].values?.rel;
  assert.deepEqual(new Set(String(linked).split(MULTI_VALUE_SEPARATOR)), new Set(["a", "b"]));
  assert.equal(readCollectionMap(rightMap)!.rows[0].values?.rel, linked);
});

test("computeColumnCalculation aggregates counts, percentages and numeric stats", () => {
  const data: CollectionData = {
    ...createDefaultCollectionData("예산"),
    properties: [
      { id: "cost", name: "비용", type: "number" },
      { id: "done", name: "완료", type: "checkbox" },
    ],
    rows: [
      { id: "1", title: "항목 1", values: { cost: "100", done: true } },
      { id: "2", title: "항목 2", values: { cost: "300", done: false } },
      { id: "3", title: "항목 3", values: { cost: "", done: true } },
    ],
  };
  const [costProp, doneProp] = data.properties;
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "count_all"), "3");
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "count_values"), "2");
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "count_empty"), "1");
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "sum"), "400");
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "average"), "200");
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "min"), "100");
  assert.equal(computeColumnCalculation(data, data.rows, costProp, "max"), "300");
  assert.equal(computeColumnCalculation(data, data.rows, doneProp, "percent_checked"), "67%");
  assert.equal(computeColumnCalculation(data, data.rows, doneProp, "percent_unchecked"), "33%");
});

