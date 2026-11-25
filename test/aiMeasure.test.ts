import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enclosuresAt, gapBetween, pointInPolygon, segmentsOf } from '../src/ai/measure';
import { pathLength, polygonArea } from '../src/dxf/measure';
import type { DxfEntity, Point2D } from '../src/shared/types';

const base = { layer: '0', color: '#fff' };
const line = (x1: number, y1: number, x2: number, y2: number, obj = 0): DxfEntity => ({
  ...base, type: 'LINE', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, obj,
});
const rect = (x: number, y: number, w: number, h: number, obj: number, layer = '0'): DxfEntity => ({
  ...base, layer, type: 'POLYLINE', closed: true, obj,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
});
const SQUARE: Point2D[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];

test('a path measures its legs, and an outline its area either way round', () => {
  assert.equal(pathLength(SQUARE, false), 11);
  assert.equal(pathLength(SQUARE, true), 14);
  assert.equal(polygonArea(SQUARE), 12);
  assert.equal(polygonArea([...SQUARE].reverse()), 12);
});

test('the gap between two parallel walls is the clear distance, with the points it runs between', () => {
  const gap = gapBetween(segmentsOf([line(0, 0, 10, 0)]), segmentsOf([line(2, 3, 8, 3)]))!;
  assert.equal(gap.distance, 3);
  assert.equal(gap.from.y, 0);
  assert.equal(gap.to.y, 3);
  assert.equal(gap.from.x, gap.to.x);
});

test('linework that crosses or touches has no gap', () => {
  assert.equal(gapBetween(segmentsOf([line(0, 0, 10, 10)]), segmentsOf([line(0, 10, 10, 0)]))!.distance, 0);
  assert.equal(gapBetween(segmentsOf([line(0, 0, 5, 0)]), segmentsOf([line(5, 0, 5, 5)]))!.distance, 0);
});

test('a point measures to the nearest part of a shape, not to its centre', () => {
  const point = segmentsOf([{ ...base, type: 'POINT', position: { x: 15, y: 5 } }]);
  assert.equal(gapBetween(point, segmentsOf([rect(0, 0, 10, 10, 1)]))!.distance, 5);
});

test('a circle is measured along its curve', () => {
  const circle = segmentsOf([{ ...base, type: 'CIRCLE', center: { x: 0, y: 0 }, radius: 10 }]);
  const gap = gapBetween(circle, segmentsOf([line(20, -5, 20, 5)]))!;
  assert.ok(Math.abs(gap.distance - 10) < 0.01, String(gap.distance));
  const arc = segmentsOf([{ ...base, type: 'ARC', center: { x: 0, y: 0 }, radius: 10, startAngle: 350, endAngle: 10 }]);
  assert.ok(arc.every((s) => s.a.x > 9.8), 'an arc across 0° stays on its short side');
});

test('a small set against a huge one keeps every segment of the small one', () => {
  // The near segment sits where even thinning of the long row would skip it
  const row: DxfEntity[] = Array.from({ length: 500_000 }, (_, i) => line(i, 100, i + 1, 100));
  row[123_457] = line(123_457, 2, 123_458, 2);
  const gap = gapBetween(segmentsOf([line(123_457, 0, 123_458, 0)]), segmentsOf(row))!;
  assert.equal(gap.distance, 2);
  assert.equal(gap.approximate, undefined);
});

test('a hatch with a hole and an island measures like the Quantities panel', () => {
  const square = (x: number, size: number): Point2D[] => [{ x, y: x }, { x: x + size, y: x }, { x: x + size, y: x + size }, { x, y: x + size }];
  const hatch: DxfEntity = { ...base, type: 'HATCH', solid: true, patternAngle: 0, patternSpacing: 0, obj: 3, loops: [square(0, 100), square(10, 80), square(40, 20)] };
  const found = enclosuresAt([hatch], { x: 50, y: 50 }, 10);
  assert.equal(found[0].area, 10000 - 6400 + 400);
  assert.equal(found[0].width, 100);
});

test('nothing to compare gives no gap', () => assert.equal(gapBetween([], segmentsOf([line(0, 0, 1, 1)])), undefined));

test('huge sets are thinned and say so', () => {
  const many = (y: number): DxfEntity[] => Array.from({ length: 3000 }, (_, i) => line(i, y, i + 1, y));
  const gap = gapBetween(segmentsOf(many(0)), segmentsOf(many(7)))!;
  assert.equal(gap.approximate, true);
  assert.ok(Math.abs(gap.distance - 7) < 1.5, String(gap.distance));
});

test('inside and outside an L-shaped outline', () => {
  const L: Point2D[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon({ x: 2, y: 8 }, L), true);
  assert.equal(pointInPolygon({ x: 8, y: 8 }, L), false);
  assert.equal(polygonArea(L), 64);
});

test('the shapes around a point come smallest first, and open linework is not a shape', () => {
  const entities: DxfEntity[] = [
    rect(-100, -100, 200, 200, 1, 'FRAME'),
    rect(0, 0, 4, 3, 2, 'ROOM'),
    rect(50, 50, 4, 3, 3, 'ROOM'),
    { ...base, type: 'POLYLINE', closed: false, obj: 4, points: SQUARE },
    { ...base, type: 'CIRCLE', center: { x: 2, y: 1 }, radius: 20, obj: 5 },
  ];
  const found = enclosuresAt(entities, { x: 2, y: 1 }, 10);
  assert.deepEqual(found.map((f) => f.obj), [2, 5, 1]);
  assert.deepEqual({ area: found[0].area, width: found[0].width, height: found[0].height }, { area: 12, width: 4, height: 3 });
  assert.equal(found[0].layer, 'ROOM');
  assert.equal(enclosuresAt(entities, { x: 2, y: 1 }, 1).length, 1);
});

test('a hole in a hatch is outside it, and its area is taken off', () => {
  const hatch: DxfEntity = {
    ...base, type: 'HATCH', solid: true, patternAngle: 0, patternSpacing: 0, obj: 7,
    loops: [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }],
    ],
  };
  assert.equal(enclosuresAt([hatch], { x: 5, y: 5 }, 10).length, 0);
  assert.equal(enclosuresAt([hatch], { x: 1, y: 1 }, 10)[0].area, 96);
});
