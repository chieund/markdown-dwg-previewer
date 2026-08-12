import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcToPathData } from '../src/webview/renderer';

/** `M sx sy A r r 0 <largeArcFlag> 1 ex ey` */
const parseArc = (d: string) => {
  const match = d.match(
    /^M (\S+) (\S+) A (\S+) (\S+) 0 (\d) (\d) (\S+) (\S+)$/
  );
  assert.ok(match, `unexpected path data: ${d}`);
  return {
    start: { x: Number(match[1]), y: Number(match[2]) },
    radius: Number(match[3]),
    largeArc: Number(match[5]),
    sweep: Number(match[6]),
    end: { x: Number(match[7]), y: Number(match[8]) },
  };
};

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

test('an arc starts and ends on the circle at the given angles', () => {
  const arc = parseArc(arcToPathData({ x: 0, y: 0 }, 10, 0, Math.PI / 2));

  near(arc.start.x, 10);
  near(arc.start.y, 0);
  near(arc.end.x, 0, 1e-9);
  near(arc.end.y, 10);
  near(arc.radius, 10);
});

test('a sweep under 180 degrees is not flagged as a large arc', () => {
  assert.equal(parseArc(arcToPathData({ x: 0, y: 0 }, 5, 0, Math.PI / 2)).largeArc, 0);
  assert.equal(parseArc(arcToPathData({ x: 0, y: 0 }, 5, 0, Math.PI * 0.99)).largeArc, 0);
});

test('a sweep over 180 degrees is flagged as a large arc', () => {
  assert.equal(parseArc(arcToPathData({ x: 0, y: 0 }, 5, 0, Math.PI * 1.5)).largeArc, 1);
});

test('a negative sweep wraps around instead of drawing backwards', () => {
  // 0 → -90° is the same as 0 → 270°, which is the long way round
  const arc = parseArc(arcToPathData({ x: 0, y: 0 }, 5, 0, -Math.PI / 2));

  assert.equal(arc.largeArc, 1);
  near(arc.end.x, 0, 1e-9);
  near(arc.end.y, -5);
});

test('arcs always sweep positively so the direction never flips', () => {
  for (const [from, to] of [
    [0, 1],
    [0, -1],
    [3, 0.5],
    [-2, 2],
  ]) {
    assert.equal(parseArc(arcToPathData({ x: 0, y: 0 }, 1, from, to)).sweep, 1);
  }
});

test('the arc is drawn around the centre it was given', () => {
  const arc = parseArc(arcToPathData({ x: 100, y: -50 }, 3, Math.PI, Math.PI * 1.5));

  near(Math.hypot(arc.start.x - 100, arc.start.y + 50), 3, 1e-9);
  near(Math.hypot(arc.end.x - 100, arc.end.y + 50), 3, 1e-9);
});
