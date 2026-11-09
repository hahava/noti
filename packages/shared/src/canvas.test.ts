import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import {
  canvasMaps,
  canvasPageIds,
  cardsInsideGroups,
  readCanvas,
  removeCanvasNodes,
  resolveNewPageParent,
  setCanvasNewPageParent,
  upsertCanvasEdge,
  upsertCanvasNode,
} from "./canvas";

test("reads nodes, edges and settings written through the helpers", () => {
  const doc = new Y.Doc();
  upsertCanvasNode(doc, "a", { type: "page", pageId: "page-1", x: 10, y: 20, width: 260, height: 160 });
  upsertCanvasNode(doc, "b", { type: "text", text: "메모", x: 300, y: 20, width: 200, height: 100 });
  upsertCanvasEdge(doc, "e1", { fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", label: "근거" });
  const data = readCanvas(doc);
  assert.equal(data.nodes.length, 2);
  assert.deepEqual(data.nodes.find((n) => n.id === "a"), {
    id: "a", type: "page", x: 10, y: 20, width: 260, height: 160, pageId: "page-1",
    text: undefined, url: undefined, label: undefined, color: undefined,
  });
  assert.equal(data.edges[0].label, "근거");
  assert.deepEqual(canvasPageIds(data), ["page-1"]);
  assert.deepEqual(data.settings, {});
});

test("removing a card removes its edges but nothing else", () => {
  const doc = new Y.Doc();
  upsertCanvasNode(doc, "a", { type: "text", x: 0, y: 0, width: 100, height: 100 });
  upsertCanvasNode(doc, "b", { type: "text", x: 0, y: 0, width: 100, height: 100 });
  upsertCanvasNode(doc, "c", { type: "text", x: 0, y: 0, width: 100, height: 100 });
  upsertCanvasEdge(doc, "ab", { fromNode: "a", toNode: "b" });
  upsertCanvasEdge(doc, "bc", { fromNode: "b", toNode: "c" });
  removeCanvasNodes(doc, ["a"]);
  const data = readCanvas(doc);
  assert.deepEqual(data.nodes.map((n) => n.id).sort(), ["b", "c"]);
  assert.deepEqual(data.edges.map((e) => e.id), ["bc"]);
});

test("concurrent edits to different cards merge", () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  upsertCanvasNode(a, "n1", { type: "text", text: "처음", x: 0, y: 0, width: 100, height: 100 });
  upsertCanvasNode(a, "n2", { type: "text", text: "둘째", x: 0, y: 0, width: 100, height: 100 });
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  upsertCanvasNode(a, "n1", { x: 50 });
  upsertCanvasNode(b, "n2", { text: "고침" });
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  for (const doc of [a, b]) {
    const nodes = readCanvas(doc).nodes;
    assert.equal(nodes.find((n) => n.id === "n1")?.x, 50);
    assert.equal(nodes.find((n) => n.id === "n2")?.text, "고침");
  }
});

test("new page location: same as canvas by default, root, chosen page, or fallback when deleted", () => {
  const doc = new Y.Doc();
  const live = new Set(["proj", "docs"]);
  assert.equal(resolveNewPageParent(readCanvas(doc).settings, "proj", live), "proj");
  setCanvasNewPageParent(doc, null);
  assert.equal(resolveNewPageParent(readCanvas(doc).settings, "proj", live), null);
  setCanvasNewPageParent(doc, "docs");
  assert.equal(resolveNewPageParent(readCanvas(doc).settings, "proj", live), "docs");
  assert.equal(resolveNewPageParent(readCanvas(doc).settings, "proj", new Set(["proj"])), "proj");
  setCanvasNewPageParent(doc, undefined);
  assert.equal(resolveNewPageParent(readCanvas(doc).settings, null, live), null);
});

test("edge ends and colors round-trip, invalid ends are ignored", () => {
  const doc = new Y.Doc();
  upsertCanvasNode(doc, "a", { type: "text", x: 0, y: 0, width: 10, height: 10 });
  upsertCanvasNode(doc, "b", { type: "text", x: 50, y: 0, width: 10, height: 10 });
  upsertCanvasEdge(doc, "e", { fromNode: "a", toNode: "b", fromEnd: "arrow", toEnd: "none", color: "3" });
  assert.deepEqual(
    (({ fromEnd, toEnd, color }) => ({ fromEnd, toEnd, color }))(readCanvas(doc).edges[0]),
    { fromEnd: "arrow", toEnd: "none", color: "3" },
  );
  canvasMaps(doc).edges.get("e")!.set("toEnd", "bogus");
  assert.equal(readCanvas(doc).edges[0].toEnd, undefined);
});

test("cardsInsideGroups: only cards fully inside the dragged groups", () => {
  const card = (id: string, x: number, y: number, w = 10, h = 10, type: "text" | "group" = "text") => ({ id, type, x, y, width: w, height: h });
  const nodes = [
    card("g", 0, 0, 100, 100, "group"),
    card("inner", 10, 10),
    card("half", 95, 10),
    card("outside", 200, 200),
    card("subgroup", 20, 20, 30, 30, "group"),
  ];
  assert.deepEqual([...cardsInsideGroups(nodes, new Set(["g"]))].sort(), ["inner", "subgroup"]);
  assert.equal(cardsInsideGroups(nodes, new Set()).size, 0);
});
