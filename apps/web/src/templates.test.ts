import assert from "node:assert/strict";
import test from "node:test";
import { pageBlocksToTemplate, templateCollectionIds, unlinkedCollectionDataJson } from "./templates";

const db = (extra: object) => ({
  id: "b1",
  type: "collection",
  props: { dataJson: JSON.stringify({ collectionId: "collection-src", title: "오래된 제목", properties: [], views: [], rows: [{ id: "r1" }], ...extra }) },
});
const latest = new Map<string, unknown>([["collection-src", { collectionId: "collection-src", title: "습관 기록", properties: [{ id: "h1", type: "checkbox" }], views: [{ id: "v", mode: "chart" }], rows: [{ id: "r1" }, { id: "r2" }] }]]);

test("templates: databases are kept as unlinked copies with the latest structure", () => {
  const blocks = [{ type: "heading", content: [] }, db({}), { id: "p", type: "page", props: { pageId: "x" } }];
  assert.deepEqual(templateCollectionIds(blocks), ["collection-src"]);
  const [copy] = pageBlocksToTemplate(blocks, true, latest) as any[];
  const data = JSON.parse(copy.props.dataJson);
  assert.equal(copy.id, undefined, "block id is dropped");
  assert.equal(data.collectionId, undefined, "no link to the original database");
  assert.equal(data.title, "습관 기록", "latest structure wins over the stale snapshot");
  assert.equal(data.views[0].mode, "chart");
  assert.deepEqual(data.rows, [], "structure only: records are emptied");
  const withRows = JSON.parse((pageBlocksToTemplate(blocks, false, latest) as any[])[0].props.dataJson);
  assert.equal(withRows.rows.length, 2);
  assert.equal((pageBlocksToTemplate(blocks, true) as any[]).length, 1, "sub-page blocks are still left out");
});

test("templates: pasted or broken database data never keeps a link", () => {
  assert.deepEqual(JSON.parse(unlinkedCollectionDataJson('{"collectionId":"c","pendingLink":true,"rows":[1]}', false)), { rows: [] });
  assert.deepEqual(JSON.parse(unlinkedCollectionDataJson("not json", true)), { rows: [] });
});
