import assert from "node:assert/strict";
import test from "node:test";
import { alignmentGuides } from "./canvas-guides";

const other = { x: 100, y: 100, width: 200, height: 100 }; // 가운데 (200, 150), 오른쪽 300, 아래 200

test("guides: snaps left edges and centers within the threshold", () => {
  const r = alignmentGuides({ x: 104, y: 400, width: 120, height: 60 }, [other]);
  assert.equal(r.x, 100, "left edge snaps to the other card's left edge");
  assert.deepEqual(r.vertical, { at: 100, from: 100, to: 460 });
  assert.equal(r.horizontal, undefined, "far away vertically: no horizontal guide");
  assert.equal(r.y, 400);

  const centered = alignmentGuides({ x: 500, y: 128, width: 80, height: 40 }, [other]); // 가운데 148 → 150
  assert.equal(centered.y, 130);
  assert.deepEqual(centered.horizontal, { at: 150, from: 100, to: 580 });
});

test("guides: nothing within threshold leaves the card where it is", () => {
  const r = alignmentGuides({ x: 120, y: 260, width: 50, height: 50 }, [other]);
  assert.deepEqual(r, { x: 120, y: 260 });
});

test("guides: picks the closest line and spans every card on it", () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  const b = { x: 0, y: 300, width: 60, height: 50 };
  // 왼쪽 2 차이(a·b 왼쪽 0) vs 오른쪽 5 차이 → 왼쪽, 선은 a~b 모두 덮는다
  const r = alignmentGuides({ x: 2, y: 150, width: 103, height: 40 }, [a, b]);
  assert.equal(r.x, 0);
  assert.deepEqual(r.vertical, { at: 0, from: 0, to: 350 });
});
