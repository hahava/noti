/**
 * 캔버스 정렬 안내선: 끄는 카드의 왼쪽·가운데·오른쪽(세로선), 위·가운데·아래(가로선)가
 * 다른 카드의 같은 기준선과 threshold 안으로 가까우면 그 선에 맞춰 붙이고 안내선을 돌려준다.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuideLine {
  /** 세로선이면 x, 가로선이면 y (캔버스 좌표) */
  at: number;
  /** 선이 그려질 구간 (맞춰진 카드들을 덮는 범위) */
  from: number;
  to: number;
}

export interface GuideResult {
  x: number;
  y: number;
  vertical?: GuideLine;
  horizontal?: GuideLine;
}

const xs = (r: Rect) => [r.x, r.x + r.width / 2, r.x + r.width];
const ys = (r: Rect) => [r.y, r.y + r.height / 2, r.y + r.height];

/** 한 축에서 가장 가까운 맞춤: 끄는 카드 기준선 하나와 다른 카드 기준선 하나의 차이 */
function bestSnap(mine: number[], others: Array<{ lines: number[]; rect: Rect }>, threshold: number) {
  let best: { delta: number; at: number; rects: Rect[] } | null = null;
  for (const other of others) {
    for (const target of other.lines) {
      for (const line of mine) {
        const delta = target - line;
        if (Math.abs(delta) > threshold) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta) - 0.01) best = { delta, at: target, rects: [other.rect] };
        else if (Math.abs(delta - best.delta) < 0.01 && target === best.at) best.rects.push(other.rect);
      }
    }
  }
  return best;
}

export function alignmentGuides(dragged: Rect, others: Rect[], threshold = 6): GuideResult {
  const vSnap = bestSnap(xs(dragged), others.map((rect) => ({ lines: xs(rect), rect })), threshold);
  const hSnap = bestSnap(ys(dragged), others.map((rect) => ({ lines: ys(rect), rect })), threshold);
  const x = dragged.x + (vSnap?.delta ?? 0);
  const y = dragged.y + (hSnap?.delta ?? 0);
  const placed = { ...dragged, x, y };
  const span = (rects: Rect[], axis: "x" | "y") => {
    const all = [placed, ...rects];
    return axis === "y"
      ? { from: Math.min(...all.map((r) => r.y)), to: Math.max(...all.map((r) => r.y + r.height)) }
      : { from: Math.min(...all.map((r) => r.x)), to: Math.max(...all.map((r) => r.x + r.width)) };
  };
  return {
    x,
    y,
    ...(vSnap ? { vertical: { at: vSnap.at, ...span(vSnap.rects, "y") } } : {}),
    ...(hSnap ? { horizontal: { at: hSnap.at, ...span(hSnap.rects, "x") } } : {}),
  };
}
