import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  calloutFromAside,
  csvToCollection,
  extractAsides,
  importNotionZip,
  inferColumnType,
  parseCsv,
  resolveRelative,
  stripPropertyLines,
  titleFromFileName,
  toIsoDate,
} from "./notion-import";

test("file names, relative links and CSV", () => {
  assert.equal(titleFromFileName("A/회의록 0123456789abcdef0123456789abcdef.md"), "회의록");
  assert.equal(titleFromFileName("Tasks 0123456789abcdef0123456789abcdef_all.csv"), "Tasks");
  assert.equal(resolveRelative("A 1/B 2.md", "C%203/img.png"), "A 1/C 3/img.png");
  assert.equal(resolveRelative("A/B/c.md", "../d.md"), "A/d.md");
  assert.equal(resolveRelative("a.md", "https://x.com"), null);
  assert.deepEqual(parseCsv('﻿Name,Note\r\n"a, b","line1\nline2"\r\n"say ""hi""",\n'), [
    ["Name", "Note"],
    ["a, b", "line1\nline2"],
    ['say "hi"', ""],
  ]);
});

test("dates and column types", () => {
  assert.equal(toIsoDate("November 9, 2026"), "2026-11-09");
  assert.equal(toIsoDate("Sep 3, 2025 3:00 PM"), "2025-09-03");
  assert.equal(toIsoDate("2026/1/5 → 2026/1/7"), "2026-01-05");
  assert.equal(toIsoDate("2026년 3월 1일"), "2026-03-01");
  assert.equal(toIsoDate("hello"), null);
  assert.equal(inferColumnType(["Yes", "No", ""]), "checkbox");
  assert.equal(inferColumnType(["1", "2.5", "-3"]), "number");
  assert.equal(inferColumnType(["November 9, 2026", "2026/11/10"]), "date");
  assert.equal(inferColumnType(["Todo", "Done", "Todo", "Doing"]), "select");
  assert.equal(inferColumnType(["a, b", "b", "a, c"]), "multi_select");
  assert.equal(inferColumnType(["Row (Row%20abc.md)"]), "text");
  assert.equal(inferColumnType(["unique 1", "unique 2"]), "text");
});

test("csvToCollection: properties, values and row page links", () => {
  const data = csvToCollection(
    "Tasks",
    [
      ["Name", "Status", "Due", "Done", "Tags"],
      ["Write", "Todo", "November 9, 2026", "No", "a, b"],
      ["Ship", "Done", "November 10, 2026", "Yes", "b"],
      ["Ship", "Todo", "", "No", "a"],
    ],
    "collection-x",
    new Map([["Ship", ["p1", "p2"]]]),
  );
  assert.equal(data.collectionId, "collection-x");
  assert.deepEqual(data.properties.map((p) => p.type), ["select", "date", "checkbox", "multi_select"]);
  assert.equal(data.rows[0].values?.["prop-2"], "2026-11-09");
  assert.equal(data.rows[1].values?.["prop-3"], true);
  assert.equal(data.rows[0].values?.["prop-4"], "a\u001fb");
  assert.equal(data.rows[1].linkedPageId, "p1");
  assert.equal(data.rows[2].linkedPageId, "p2");
  assert.equal(data.rows[0].linkedPageId, undefined);
});

test("row page property lines and callouts", () => {
  assert.equal(stripPropertyLines("# Ship\n\nStatus: Done\nDue: x\n\nBody", ["Status", "Due"]), "# Ship\n\n\nBody");
  assert.equal(stripPropertyLines("# A\n\nStatus is good", ["Status"]), "# A\n\nStatus is good");
  const { markdown, asides } = extractAsides("x\n<aside>\n💡 tip\n</aside>\ny");
  assert.deepEqual(asides, ["💡 tip"]);
  assert.match(markdown, /NOTYASIDE0/);
  assert.deepEqual(calloutFromAside("💡 tip text"), { variant: "info", text: "tip text" });
  assert.deepEqual(calloutFromAside("⚠️ careful"), { variant: "warning", text: "careful" });
  assert.deepEqual(calloutFromAside("plain"), { variant: "info", text: "plain" });
});

/** 테스트용 마크다운 변환: 제목·이미지·링크 한 줄 정도만 */
function fakeParse(markdown: string): any[] {
  return markdown
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const heading = line.match(/^(#+)\s+(.*)$/);
      if (heading) return { type: "heading", props: { level: heading[1].length }, content: [{ type: "text", text: heading[2], styles: {} }] };
      const image = line.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
      if (image) return { type: "image", props: { url: image[1] } };
      const content = line.split(/(\[[^\]]+\]\([^)]+\))/).filter(Boolean).map((part) => {
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        return link ? { type: "link", href: link[2], content: [{ type: "text", text: link[1], styles: {} }] } : { type: "text", text: part, styles: {} };
      });
      return { type: "paragraph", content };
    });
}

test("importNotionZip: pages, links, images, databases and row pages", async () => {
  const id = (n: number) => String(n).repeat(32).slice(0, 32);
  const zip = new JSZip();
  zip.file(`Home ${id(1)}.md`, `# Home\n\nSee [Notes](Home%20${id(1)}/Notes%20${id(2)}.md) inline.\n\n[Tasks](Home%20${id(1)}/Tasks%20${id(3)}.csv)\n\n![](Home%20${id(1)}/pic.png)\n\n<aside>\n💡 Remember\n</aside>`);
  zip.file(`Home ${id(1)}/Notes ${id(2)}.md`, "# Notes\n\nbody");
  zip.file(`Home ${id(1)}/pic.png`, new Uint8Array([1, 2, 3]));
  zip.file(`Home ${id(1)}/Tasks ${id(3)}.csv`, "Name,Status\nShip,Todo\n");
  zip.file(`Home ${id(1)}/Tasks ${id(3)}_all.csv`, "Name,Status\nShip,Todo\nWrite,Done\n");
  zip.file(`Home ${id(1)}/Tasks ${id(3)}/Ship ${id(4)}.md`, "# Ship\n\nStatus: Todo\n\nRow body");
  // 큰 내보내기처럼 ZIP 안에 ZIP
  const outer = new JSZip();
  outer.file("Export-Part-1.zip", await zip.generateAsync({ type: "uint8array" }));
  const blob = new Blob([await outer.generateAsync({ type: "arraybuffer" })]);

  const pages: { id: string; parentId: string | null; title: string }[] = [];
  const saved = new Map<string, any[]>();
  const collections: any[] = [];
  let uploads = 0;
  const report = await importNotionZip(blob, "Notion 가져오기", {
    parseMarkdown: fakeParse,
    createPage: async (parentId, title) => {
      const pageId = `p${pages.length}`;
      pages.push({ id: pageId, parentId, title });
      return pageId;
    },
    saveBlocks: async (pageId, blocks) => void saved.set(pageId, blocks as any[]),
    uploadFile: async () => `https://files/${++uploads}`,
    ensureCollection: async (cid, owner, data) => void collections.push({ cid, owner, data }),
    onProgress: () => undefined,
  });

  const byTitle = (t: string) => pages.find((p) => p.title === t)!;
  assert.equal(report.pages, 3);
  assert.equal(report.databases, 1);
  assert.equal(report.rows, 2, "uses _all.csv");
  assert.equal(report.files, 1);
  assert.deepEqual(report.warnings, []);
  assert.equal(byTitle("Home").parentId, report.rootPageId);
  assert.equal(byTitle("Notes").parentId, byTitle("Home").id);
  assert.equal(byTitle("Tasks").parentId, byTitle("Home").id);
  assert.equal(byTitle("Ship").parentId, byTitle("Tasks").id, "row page under its database page");

  const home = saved.get(byTitle("Home").id)!;
  const flat = JSON.stringify(home);
  assert.ok(flat.includes(`"type":"pageLink","props":{"pageId":"${byTitle("Notes").id}"}`), "inline link → page link");
  assert.ok(home.some((b) => b.type === "page" && b.props.pageId === byTitle("Tasks").id), "database link line → page block");
  assert.ok(home.some((b) => b.type === "image" && b.props.url === "https://files/1"), "image uploaded");
  assert.ok(home.some((b) => b.type === "callout"), "aside → callout");
  assert.ok(home.some((b) => b.type === "page" && b.props.pageId === byTitle("Notes").id), "child page listed");

  assert.equal(collections.length, 1);
  assert.equal(collections[0].owner, byTitle("Tasks").id);
  assert.equal(collections[0].data.rows.find((r: any) => r.title === "Ship").linkedPageId, byTitle("Ship").id);
  const ship = JSON.stringify(saved.get(byTitle("Ship").id));
  assert.ok(!ship.includes("Status: Todo"), "property lines removed from row page");
  assert.ok(ship.includes("Row body"));
});
