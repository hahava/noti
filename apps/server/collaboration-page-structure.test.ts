import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import {
  collectYjsPageReferences,
  ensureYjsChildPageBlocks,
  pruneYjsPageReferences,
} from "./collaboration-page-structure.js";

function block(type: string, id: string, pageId?: string): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const content = new Y.XmlElement(type);
  if (pageId) content.setAttribute("pageId", pageId);
  container.insert(0, [content]);
  return container;
}

test("removes only deleted page blocks while preserving surrounding Yjs text", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  const group = new Y.XmlElement("blockGroup");
  const before = block("paragraph", "before");
  group.insert(0, [before, block("page", "deleted", "gone"), block("page", "kept", "child")]);
  fragment.insert(0, [group]);
  const text = new Y.XmlText();
  text.insert(0, "본문 그대로");
  (before.toArray()[0] as Y.XmlElement).insert(0, [text]);

  assert.deepEqual(collectYjsPageReferences(fragment), ["gone", "child"]);
  assert.equal(pruneYjsPageReferences(fragment, "parent", new Map([["child", "parent"]])), true);
  assert.deepEqual(group.toArray().map((item) => (item as Y.XmlElement).getAttribute("id")), ["before", "kept"]);
  assert.equal(((before.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText).toString(), "본문 그대로");
  assert.equal(pruneYjsPageReferences(fragment, "parent", new Map([["child", "parent"]])), false);
});

test("keeps an empty root valid after removing its only page block", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, [block("page", "deleted", "gone")]);
  fragment.insert(0, [group]);
  assert.equal(pruneYjsPageReferences(fragment, "parent", new Map()), true);
  const remaining = group.toArray()[0] as Y.XmlElement;
  assert.equal(remaining.nodeName, "blockContainer");
  assert.equal((remaining.toArray()[0] as Y.XmlElement).nodeName, "paragraph");
});

test("removes a deleted inline page link without changing adjacent text", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  const group = new Y.XmlElement("blockGroup");
  const paragraph = block("paragraph", "body");
  group.insert(0, [paragraph]);
  fragment.insert(0, [group]);
  const content = paragraph.toArray()[0] as Y.XmlElement;
  const before = new Y.XmlText();
  before.insert(0, "앞 ");
  const link = new Y.XmlElement("pageLink");
  link.setAttribute("pageId", "gone");
  const after = new Y.XmlText();
  after.insert(0, " 뒤");
  content.insert(0, [before, link, after]);

  assert.deepEqual(collectYjsPageReferences(fragment), ["gone"]);
  assert.equal(pruneYjsPageReferences(fragment, "parent", new Map()), true);
  assert.deepEqual(content.toArray().map((node) => node.toString()), ["앞 ", " 뒤"]);
});

function pageIdsInOrder(group: Y.XmlElement): Array<string | null> {
  return group.toArray().map((item) => {
    const content = (item as Y.XmlElement).toArray()[0] as Y.XmlElement;
    return content.nodeName === "page" ? (content.getAttribute("pageId") as string) : content.nodeName;
  });
}

test("adds a page block for a child moved into an open document, before the trailing empty paragraph", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  const group = new Y.XmlElement("blockGroup");
  const intro = block("paragraph", "intro");
  group.insert(0, [intro, block("page", "existing", "child-a"), block("paragraph", "trailing")]);
  fragment.insert(0, [group]);
  // 문서에 붙은 뒤에야 하위 요소에 접근할 수 있다.
  const text = new Y.XmlText();
  text.insert(0, "기존 본문");
  (intro.toArray()[0] as Y.XmlElement).insert(0, [text]);

  assert.equal(ensureYjsChildPageBlocks(fragment, ["child-a", "moved-in"]), true);
  assert.deepEqual(pageIdsInOrder(group), ["paragraph", "child-a", "moved-in", "paragraph"]);
  assert.equal(((intro.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText).toString(), "기존 본문");
  // 이미 맞으면 아무것도 바꾸지 않는다.
  assert.equal(ensureYjsChildPageBlocks(fragment, ["child-a", "moved-in"]), false);
});

test("appends at the end when the last block has content, and removes duplicate page blocks", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  const group = new Y.XmlElement("blockGroup");
  const last = block("paragraph", "last");
  group.insert(0, [block("page", "a1", "child-a"), block("page", "a2", "child-a"), last]);
  fragment.insert(0, [group]);
  const text = new Y.XmlText();
  text.insert(0, "마지막 문단");
  (last.toArray()[0] as Y.XmlElement).insert(0, [text]);

  assert.equal(ensureYjsChildPageBlocks(fragment, ["child-a", "child-b"]), true);
  assert.deepEqual(pageIdsInOrder(group), ["child-a", "paragraph", "child-b"]);
  assert.deepEqual(collectYjsPageReferences(fragment), ["child-a", "child-b"]);
});

test("does nothing when the page has no children", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document-store");
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, [block("paragraph", "only")]);
  fragment.insert(0, [group]);
  assert.equal(ensureYjsChildPageBlocks(fragment, []), false);
});

