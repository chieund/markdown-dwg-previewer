import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandBulges } from '../src/dxf/bulge';

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

const distance = (p: { x: number; y: number }, cx: number, cy: number) =>
  Math.hypot(p.x - cx, p.y - cy);

test('a single vertex is returned as-is', () => {
  assert.deepEqual(expandBulges([{ x: 1, y: 2 }], false), [{ x: 1, y: 2 }]);
});

test('vertices without bulge stay a straight polyline', () => {
  const points = expandBulges(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    false
  );
  assert.deepEqual(points, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
});

test('a zero bulge is a straight segment, not a degenerate arc', () => {
  const points = expandBulges([{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0 }], false);
  assert.deepEqual(points, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
});

test('bulge of 1 draws a semicircle', () => {
  const points = expandBulges([{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }], false);

  // 1 start + 31 interior points + 1 end
  assert.equal(points.length, 33);
  assert.deepEqual(points[0], { x: 0, y: 0 });
  assert.deepEqual(points[points.length - 1], { x: 10, y: 0 });

  // Every point sits on the circle centred on the chord midpoint
  for (const point of points) near(distance(point, 5, 0), 5, 1e-9);

  // A positive bulge sweeps counter-clockwise, which puts the apex below the chord
  near(points[16].x, 5);
  near(points[16].y, -5);
});

test('a negative bulge sweeps the other way', () => {
  const points = expandBulges([{ x: 0, y: 0, bulge: -1 }, { x: 10, y: 0 }], false);

  assert.equal(points.length, 33);
  for (const point of points) near(distance(point, 5, 0), 5, 1e-9);

  near(points[16].x, 5);
  near(points[16].y, 5, 1e-9);
});

test('a quarter-circle bulge produces fewer segments than a semicircle', () => {
  const quarter = Math.tan(Math.PI / 2 / 4); // included angle 90°
  const points = expandBulges([{ x: 0, y: 0, bulge: quarter }, { x: 10, y: 0 }], false);

  assert.ok(points.length > 2, 'the arc must be subdivided');
  assert.ok(points.length < 33, 'a 90° arc needs fewer points than a 180° one');

  const radius = distance(points[0], 5, 5);
  for (const point of points) near(distance(point, 5, 5), radius, 1e-6);
});

test('a closed polyline does not repeat its first point', () => {
  const points = expandBulges(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    true
  );
  assert.equal(points.length, 3, 'the renderer closes the shape itself');
  assert.deepEqual(points[0], { x: 0, y: 0 });
  assert.deepEqual(points[2], { x: 10, y: 10 });
});

test('a closed polyline expands the bulge on its final segment too', () => {
  const open = expandBulges([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10, bulge: 1 }], false);
  const closed = expandBulges([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10, bulge: 1 }], true);

  assert.equal(open.length, 3, 'an open polyline ignores the bulge on its last vertex');
  assert.ok(closed.length > 3, 'a closed one arcs from the last vertex back to the first');
});

test('coincident points produce no arc instead of dividing by zero', () => {
  const points = expandBulges([{ x: 5, y: 5, bulge: 1 }, { x: 5, y: 5 }], false);
  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
});
