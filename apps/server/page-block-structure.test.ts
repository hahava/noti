import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPageBlockIdsInOrder,
  reconcileChildPageBlocks,
  removePageBlocksFromTree,
} from "./page-block-structure.js";

const page = (id: string, pageId: string) => ({
  id,
  type: "page",
  props: { pageId },
  content: [],
  children: [],
});
const paragraph = (id: string, text = "") => ({ id, type: "paragraph", content: text, children: [] });

test("deleting a child page does not add nested blank paragraphs to parent text", () => {
  const blocks = [
    { id: "heading", type: "heading", content: "Parent", children: [] },
    paragraph("before", "Before"),
    page("child-block", "deleted-child"),
    paragraph("after", "After"),
  ];
  const next = removePageBlocksFromTree(blocks, new Set(["deleted-child"]));
  assert.deepEqual(next, [blocks[0], blocks[1], blocks[3]]);
});

test("deleting the only page keeps one root paragraph and an empty column valid", () => {
  const deleted = new Set(["deleted-child"]);
  const root = removePageBlocksFromTree([page("only", "deleted-child")], deleted);
  assert.equal(root.length, 1);
  assert.equal((root[0] as any).type, "paragraph");
  const column = removePageBlocksFromTree([
    { id: "column", type: "column", children: [page("nested", "deleted-child")] },
  ], deleted) as any[];
  assert.equal(column[0].children.length, 1);
  assert.equal(column[0].children[0].type, "paragraph");
  assert.deepEqual(column[0].children[0].children, []);
});

test("removes page blocks that are no longer children and dedupes", () => {
  const blocks = [paragraph("p1"), page("b1", "a"), page("b2", "moved"), page("b3", "a")];
  const { blocks: next, changed } = reconcileChildPageBlocks(blocks, ["a"], { reorder: false });
  assert.equal(changed, true);
  assert.deepEqual(extractPageBlockIdsInOrder(next), ["a"]);
  assert.equal(next.length, 2);
});

test("appends missing children at the end", () => {
  const blocks = [paragraph("p1"), page("b1", "a")];
  const { blocks: next } = reconcileChildPageBlocks(blocks, ["a", "b"], { reorder: false });
  assert.deepEqual(extractPageBlockIdsInOrder(next), ["a", "b"]);
});

test("inserts missing children before the trailing empty paragraph", () => {
  const blocks = [paragraph("p1", "본문"), page("b1", "a"), paragraph("tail")];
  const { blocks: next } = reconcileChildPageBlocks(blocks, ["a", "b"], { reorder: false });
  assert.equal((next as any[])[0].id, "p1");
  assert.equal((next as any[])[1].id, "b1");
  assert.equal((next as any[])[2].type, "page");
  assert.equal((next as any[])[3].id, "tail");
  assert.deepEqual(extractPageBlockIdsInOrder(next), ["a", "b"]);
});

test("reorders page blocks in place following sort order", () => {
  const blocks = [page("b1", "a"), paragraph("p1", "middle"), page("b2", "b"), page("b3", "c")];
  const { blocks: next, changed } = reconcileChildPageBlocks(blocks, ["c", "a", "b"], {
    reorder: true,
  });
  assert.equal(changed, true);
  assert.deepEqual(extractPageBlockIdsInOrder(next), ["c", "a", "b"]);
  // 문단 위치는 그대로 유지
  assert.equal((next[1] as { id: string }).id, "p1");
  // 기존 블록 id 를 그대로 재사용
  assert.equal((next[0] as { id: string }).id, "b3");
});

test("reorders across nested column layouts", () => {
  const blocks = [
    {
      id: "cl",
      type: "columnList",
      children: [
        { id: "c1", type: "column", children: [page("b1", "a")] },
        { id: "c2", type: "column", children: [page("b2", "b")] },
      ],
    },
  ];
  const { blocks: next } = reconcileChildPageBlocks(blocks, ["b", "a"], { reorder: true });
  assert.deepEqual(extractPageBlockIdsInOrder(next), ["b", "a"]);
});

test("keeps a placeholder paragraph when a column becomes empty", () => {
  const blocks = [
    {
      id: "cl",
      type: "columnList",
      children: [
        { id: "c1", type: "column", children: [page("b1", "gone")] },
        { id: "c2", type: "column", children: [paragraph("p")] },
      ],
    },
  ];
  const { blocks: next } = reconcileChildPageBlocks(blocks, [], { reorder: true });
  const column = (next[0] as any).children[0];
  assert.equal(column.children.length, 1);
  assert.equal(column.children[0].type, "paragraph");
});

test("reports unchanged when structure already matches", () => {
  const blocks = [paragraph("p1"), page("b1", "a"), page("b2", "b")];
  const { changed } = reconcileChildPageBlocks(blocks, ["a", "b"], { reorder: true });
  assert.equal(changed, false);
});
