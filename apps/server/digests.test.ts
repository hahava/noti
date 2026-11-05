import assert from "node:assert/strict";
import test from "node:test";
import { parseDigestOutput } from "./digests.js";

test("parses a digest wrapped in a code fence with surrounding text", () => {
  const output = '정리본입니다:\n```json\n{"summary":" 요약 ","keyPoints":["a",1,""],"concepts":[{"name":"PGroonga","description":"한국어 검색"},{"description":"이름 없음"}],"decisions":"문자열은 무시","actionItems":["할 일"]}\n```';
  const digest = parseDigestOutput(output);
  assert.equal(digest.summary, "요약");
  assert.deepEqual(digest.keyPoints, ["a"]);
  assert.deepEqual(digest.concepts, [{ name: "PGroonga", description: "한국어 검색" }]);
  assert.deepEqual(digest.decisions, []);
  assert.deepEqual(digest.actionItems, ["할 일"]);
  assert.deepEqual(digest.openQuestions, []);
});

test("caps list sizes", () => {
  const digest = parseDigestOutput(JSON.stringify({ summary: "s", keyPoints: Array.from({ length: 20 }, (_, i) => `p${i}`) }));
  assert.equal(digest.keyPoints.length, 7);
});

test("rejects output without JSON or without a summary", () => {
  assert.throws(() => parseDigestOutput("모르겠습니다"), /JSON/);
  assert.throws(() => parseDigestOutput('{"keyPoints":["a"]}'), /summary/);
  assert.throws(() => parseDigestOutput("{not json}"), /JSON/);
});
