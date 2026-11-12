import assert from "node:assert/strict";
import test from "node:test";
import { aiMarkdownToBlocks, blocksToAIMarkdown, cleanAIMarkdown } from "./ai-markdown";

const text = (t: string) => [{ type: "text", text: t, styles: {} }];
/** 테스트용: 블록 종류와 글만 적는다 */
const fakeToMarkdown = (blocks: any[]) => blocks.map((b) => `${b.type === "heading" ? "# " : ""}${b.content?.[0]?.text ?? ""}`).join("\n\n");
const fakeParse = (md: string) =>
  md.split(/\n{2,}/).map((chunk) => (chunk.startsWith("# ") ? { type: "heading", content: text(chunk.slice(2)) } : { type: "paragraph", content: text(chunk) }));

test("blocksToAIMarkdown: plain blocks, Noty conventions and placeholders", () => {
  const collection = { id: "c1", type: "collection", props: {} };
  const bookmark = { id: "b1", type: "bookmark", props: { url: "https://example.com", title: "Ex" } };
  const { markdown, originals } = blocksToAIMarkdown(
    [
      { type: "heading", content: text("Title") },
      { type: "callout", props: { variant: "warning" }, content: text("careful") },
      collection,
      bookmark,
      { type: "mathBlock", content: "E=mc^2" },
      { type: "toc" },
      { type: "heading", props: { isToggleable: true }, content: text("toggle") },
    ],
    fakeToMarkdown,
  );
  assert.equal(markdown, "# Title\n\n> ⚠️ careful\n\n<<block:1>>\n\nhttps://example.com\n\n$$\nE=mc^2\n$$\n\n[목차]\n\n<<block:2>>");
  assert.equal(originals.get("1"), collection);
  assert.equal(originals.get("url:https://example.com"), bookmark);
});

test("aiMarkdownToBlocks: restores placeholders and converts conventions", () => {
  const collection = { id: "c1", type: "collection" };
  const lost = { id: "p1", type: "page" };
  const bookmark = { id: "b1", type: "bookmark", props: { url: "https://example.com", title: "Ex" } };
  const originals = new Map<string, any>([["1", collection], ["2", lost], ["url:https://example.com", bookmark]]);
  const blocks = aiMarkdownToBlocks(
    "```markdown\n# New\n\n> 💡 tip here\n\n<<block:1>>\n\nhttps://example.com\n\nhttps://youtu.be/abcdefghijk\n\n$$x^2$$\n\n```mermaid\ngraph TD; A-->B\n```\n\n[목차]\n\nbody\n```",
    fakeParse,
    originals,
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "callout", "collection", "bookmark", "embed", "mathBlock", "diagram", "toc", "paragraph", "page"],
  );
  assert.equal(blocks[1].props?.variant, "info");
  assert.equal(blocks[2], collection);
  assert.equal(blocks[3], bookmark, "same URL keeps the fetched bookmark");
  assert.equal(blocks[6].content, "graph TD; A-->B");
  assert.equal(blocks[9], lost, "dropped placeholder is appended, not lost");
});

test("cleanAIMarkdown and code fences stay code", () => {
  assert.equal(cleanAIMarkdown("<think>hmm</think>\nhello"), "hello");
  assert.equal(cleanAIMarkdown("고친 점: 띄어쓰기\n<result>\n# 제목\n\n본문\n</result>\n이상입니다."), "# 제목\n\n본문");
  assert.equal(cleanAIMarkdown("<result>\n쓰는 중"), "쓰는 중");
  const blocks = aiMarkdownToBlocks("```js\nconst a = 1;\nhttps://not-a-bookmark.com\n```", (md) => [{ type: "codeBlock", content: md }]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "codeBlock");
});
