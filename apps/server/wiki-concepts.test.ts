import assert from "node:assert/strict";
import test from "node:test";
import { conceptIdFor, normalizeConceptName, parseConceptArticle } from "./wiki-concepts.js";

test("normalizes concept names across case, width and spacing", () => {
  assert.equal(normalizeConceptName("PGroonga"), "pgroonga");
  assert.equal(normalizeConceptName(" ＰＧｒｏｏｎｇａ "), "pgroonga");
  assert.equal(normalizeConceptName("bge-m3"), normalizeConceptName("BGE M3"));
  assert.equal(normalizeConceptName("레플리카 증설"), "레플리카증설");
  assert.equal(conceptIdFor("pgroonga"), conceptIdFor(normalizeConceptName("PGroonga")));
  assert.match(conceptIdFor("pgroonga"), /^concept-[a-f0-9]{16}$/);
});

test("parses a concept article and maps source numbers to page ids", () => {
  const pages = new Map([[1, "page-a"], [2, "page-b"]]);
  const article = parseConceptArticle(
    '```json\n{"summary":"요약","points":[{"text":"사실","sources":[1,2,9]},{"text":""}],"conflicts":[{"text":"수치가 다름","sources":[2]},"예전 형식 문자열"]}\n```',
    pages,
  );
  assert.equal(article.summary, "요약");
  assert.deepEqual(article.points, [{ text: "사실", pageIds: ["page-a", "page-b"] }]);
  assert.deepEqual(article.conflicts, [
    { text: "수치가 다름", pageIds: ["page-b"] },
    { text: "예전 형식 문자열", pageIds: [] },
  ]);
});

test("rejects concept articles without a summary", () => {
  assert.throws(() => parseConceptArticle('{"points":[]}', new Map()), /summary/);
  assert.throws(() => parseConceptArticle("없음", new Map()), /JSON/);
});

test("replaces document numbers in the text with page titles", () => {
  const article = parseConceptArticle(
    '{"summary":"문서 1 기준 요약","points":[],"conflicts":[{"text":"문서 2에서는 1개, 문서 3에서는 2개","sources":[2,3]}]}',
    new Map([[1, "a"], [2, "b"], [3, "c"]]),
    new Map([[1, "회의록"], [2, "인프라 현황"], [3, "11월 회의"]]),
  );
  assert.equal(article.summary, "‘회의록’ 기준 요약");
  assert.equal(article.conflicts[0].text, "‘인프라 현황’에서는 1개, ‘11월 회의’에서는 2개");
});
