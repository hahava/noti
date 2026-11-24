import assert from "node:assert/strict";
import test from "node:test";
import { emptyHistory, recordVisit, stepHistory } from "./nav-history";

const all = () => true;

test("nav history: back and forward like a browser", () => {
  let h = ["home", "a", "b", "c"].reduce(recordVisit, emptyHistory());
  assert.deepEqual(h, { back: ["home", "a", "b"], forward: [], current: "c" });
  let step = stepHistory(h, "back", all)!;
  assert.equal(step.target, "b");
  step = stepHistory(step.history, "back", all)!;
  assert.equal(step.target, "a");
  assert.deepEqual(step.history, { back: ["home"], forward: ["c", "b"], current: "a" });
  step = stepHistory(step.history, "forward", all)!;
  assert.equal(step.target, "b");
  // 뒤로 간 뒤 새 페이지를 열면 앞으로 기록은 사라진다
  h = recordVisit(step.history, "z");
  assert.deepEqual(h, { back: ["home", "a", "b"], forward: [], current: "z" });
  assert.equal(stepHistory(h, "forward", all), null);
});

test("nav history: skips deleted pages, ignores blank tabs and repeats", () => {
  const h = ["a", "", "gone", "gone", "b"].reduce(recordVisit, emptyHistory());
  assert.deepEqual(h.back, ["a", "gone"]);
  const step = stepHistory(h, "back", (id) => id !== "gone")!;
  assert.equal(step.target, "a");
  assert.equal(stepHistory(emptyHistory(), "back", all), null);
});
