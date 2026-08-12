import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSpline } from '../src/dxf/spline';

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

const square = [
  { x: 0, y: 0 },
  { x: 0, y: 10 },
  { x: 10, y: 10 },
  { x: 10, y: 0 },
];

test('malformed splines return nothing so the caller can fall back', () => {
  assert.deepEqual(sampleSpline([], [], 3), [], 'no control points');
  assert.deepEqual(sampleSpline(square, [0, 0, 0, 0, 1, 1, 1, 1], 0), [], 'degree below 1');
  assert.deepEqual(
    sampleSpline([{ x: 0, y: 0 }, { x: 1, y: 1 }], [0, 0, 0, 1, 1, 1], 3),
    [],
    'fewer control points than the degree allows'
  );
  assert.deepEqual(sampleSpline(square, [0, 0, 1, 1], 3), [], 'knot vector of the wrong length');
  assert.deepEqual(
    sampleSpline(square, [0, 0, 0, 0, 0, 0, 0, 0], 3),
    [],
    'empty parameter domain'
  );
});

test('a degree-1 spline reproduces the control polygon', () => {
  const points = sampleSpline(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    [0, 0, 1, 2, 2],
    1
  );

  assert.equal(points.length, 17);
  near(points[0].x, 0);
  near(points[0].y, 0);
  near(points[8].x, 10, 1e-9);
  near(points[8].y, 0, 1e-9);
  near(points[16].x, 10);
  near(points[16].y, 10);
});

test('a clamped cubic passes exactly through its first and last control point', () => {
  const points = sampleSpline(square, [0, 0, 0, 0, 1, 1, 1, 1], 3);

  near(points[0].x, 0);
  near(points[0].y, 0);
  near(points[points.length - 1].x, 10);
  near(points[points.length - 1].y, 0);
});

test('a clamped cubic matches the Bezier it is equivalent to', () => {
  // With knots [0,0,0,0,1,1,1,1] de Boor reduces to de Casteljau, so the
  // midpoint must be (P0 + 3·P1 + 3·P2 + P3) / 8 = (5, 7.5)
  const points = sampleSpline(square, [0, 0, 0, 0, 1, 1, 1, 1], 3);

  assert.equal(points.length, 9);
  near(points[4].x, 5, 1e-12);
  near(points[4].y, 7.5, 1e-12);
});

test('the curve stays inside the convex hull of its control points', () => {
  const points = sampleSpline(square, [0, 0, 0, 0, 1, 1, 1, 1], 3);

  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'no NaN leaks out');
    assert.ok(point.x >= -1e-9 && point.x <= 10 + 1e-9, `x out of hull: ${point.x}`);
    assert.ok(point.y >= -1e-9 && point.y <= 10 + 1e-9, `y out of hull: ${point.y}`);
  }
});

test('sampling density grows with the number of spans', () => {
  const oneSpan = sampleSpline(square, [0, 0, 0, 0, 1, 1, 1, 1], 3);
  const twoSpans = sampleSpline(
    [...square, { x: 20, y: 0 }],
    [0, 0, 0, 0, 1, 2, 2, 2, 2],
    3
  );

  assert.ok(twoSpans.length > oneSpan.length);
});
