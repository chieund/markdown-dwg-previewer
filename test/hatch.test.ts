import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanHatches } from '../src/dxf/hatch';

const dxf = (...lines: string[]) => lines.join('\n');

/** A square boundary stored as a closed polyline loop (path flag bit 2). */
const squareLoop = [
  '92', '2',
  '72', '0',
  '73', '1',
  '93', '4',
  '10', '0.0',
  '20', '0.0',
  '10', '10.0',
  '20', '0.0',
  '10', '10.0',
  '20', '10.0',
  '10', '0.0',
  '20', '10.0',
  '97', '0',
];

test('a solid hatch is recovered from raw group codes', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', 'WALL-FILL',
    '62', '3',
    '2', 'SOLID',
    '70', '1',
    '91', '1',
    ...squareLoop,
    '0', 'ENDSEC'
  );

  const hatches = scanHatches(text);

  assert.equal(hatches.length, 1);
  assert.equal(hatches[0].layer, 'WALL-FILL');
  assert.equal(hatches[0].colorIndex, 3);
  assert.equal(hatches[0].solid, true);
  assert.equal(hatches[0].patternName, 'SOLID');
  assert.equal(hatches[0].blockName, null);
  assert.equal(hatches[0].inPaperSpace, false);
  assert.equal(hatches[0].loops.length, 1);
  assert.deepEqual(hatches[0].loops[0], [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]);
});

test('a patterned hatch keeps its angle and scale', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', '0',
    '2', 'ANSI31',
    '70', '0',
    ...squareLoop,
    '52', '45.0',
    '41', '2.5',
    '0', 'ENDSEC'
  );

  const hatches = scanHatches(text);

  assert.equal(hatches.length, 1);
  assert.equal(hatches[0].solid, false);
  assert.equal(hatches[0].patternName, 'ANSI31');
  assert.equal(hatches[0].patternAngle, 45);
  assert.equal(hatches[0].patternScale, 2.5);
});

test('a hatch in paper space is flagged as such', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', '0',
    '67', '1',
    '2', 'SOLID',
    '70', '1',
    ...squareLoop,
    '0', 'ENDSEC'
  );

  assert.equal(scanHatches(text)[0].inPaperSpace, true);
});

test('a hatch inside a block records the block holding it', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'BLOCKS',
    '0', 'BLOCK',
    '2', 'DOOR',
    '0', 'HATCH',
    '8', '0',
    '2', 'SOLID',
    '70', '1',
    ...squareLoop,
    '0', 'ENDBLK',
    '0', 'ENDSEC'
  );

  assert.equal(scanHatches(text)[0].blockName, 'DOOR');
});

test('a boundary too small to enclose an area is dropped', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', '0',
    '2', 'SOLID',
    '70', '1',
    '92', '2',
    '73', '1',
    '93', '2',
    '10', '0.0',
    '20', '0.0',
    '10', '10.0',
    '20', '0.0',
    '97', '0',
    '0', 'ENDSEC'
  );

  assert.deepEqual(scanHatches(text), [], 'two points cannot bound a filled region');
});

test('hatches outside ENTITIES and BLOCKS are ignored', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'OBJECTS',
    '0', 'HATCH',
    '8', '0',
    '2', 'SOLID',
    '70', '1',
    ...squareLoop,
    '0', 'ENDSEC'
  );

  assert.deepEqual(scanHatches(text), []);
});

test('several hatches in one file are all found', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', 'A',
    '2', 'SOLID',
    '70', '1',
    ...squareLoop,
    '0', 'HATCH',
    '8', 'B',
    '2', 'SOLID',
    '70', '1',
    ...squareLoop,
    '0', 'ENDSEC'
  );

  const hatches = scanHatches(text);

  assert.equal(hatches.length, 2);
  assert.deepEqual(hatches.map((h) => h.layer), ['A', 'B']);
});

test('a curved boundary is flattened into a polygon', () => {
  // Same square, but the first edge bulges out into a semicircle
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', '0',
    '2', 'SOLID',
    '70', '1',
    '92', '2',
    '72', '1',
    '73', '1',
    '93', '4',
    '10', '0.0',
    '20', '0.0',
    '42', '1.0',
    '10', '10.0',
    '20', '0.0',
    '10', '10.0',
    '20', '10.0',
    '10', '0.0',
    '20', '10.0',
    '97', '0',
    '0', 'ENDSEC'
  );

  const loop = scanHatches(text)[0].loops[0];

  assert.ok(loop.length > 4, 'the arc must be subdivided into segments');
  for (const point of loop) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
});

/** One hatch whose single loop is the given edges (path type 0: edge-defined). */
function edgeHatch(...edges: string[][]): string {
  return dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'HATCH',
    '8', '0',
    '2', 'SOLID',
    '70', '1',
    '91', '1',
    '92', '0',
    '93', String(edges.length),
    ...edges.flat(),
    '97', '0',
    '0', 'ENDSEC'
  );
}

const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);

/** Signed angle swept along a sampled arc around the origin, in degrees. */
function sweptDegrees(points: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i - 1].y, points[i - 1].x);
    const b = Math.atan2(points[i].y, points[i].x);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return (total * 180) / Math.PI;
}

test('a clockwise circular edge sweeps the arc its angles describe, not the rest of the circle (issue #4)', () => {
  // DXF stores a clockwise edge's angles mirrored: 0..120 clockwise runs from 0° to -120°
  const [hatch] = scanHatches(edgeHatch(['72', '2', '10', '0', '20', '0', '40', '10', '50', '0', '51', '120', '73', '0']));
  const loop = hatch.loops[0];
  near(sweptDegrees(loop), -120, 'sweep');
  near(loop[0].x, 10, 'start x');
  near(loop[0].y, 0, 'start y');
  near(loop[loop.length - 1].x, 10 * Math.cos((-120 * Math.PI) / 180), 'end x');
  near(loop[loop.length - 1].y, 10 * Math.sin((-120 * Math.PI) / 180), 'end y');
});

test('a counter-clockwise circular edge is unchanged', () => {
  const [hatch] = scanHatches(edgeHatch(['72', '2', '10', '0', '20', '0', '40', '10', '50', '0', '51', '120', '73', '1']));
  near(sweptDegrees(hatch.loops[0]), 120, 'sweep');
});

test('a full clockwise circle edge still makes a whole turn', () => {
  const [hatch] = scanHatches(edgeHatch(['72', '2', '10', '0', '20', '0', '40', '10', '50', '0', '51', '360', '73', '0']));
  near(Math.abs(sweptDegrees(hatch.loops[0])), 360, 'sweep');
});

test('a clockwise elliptic edge stays in the quadrant its angles describe (issue #4)', () => {
  const [hatch] = scanHatches(
    edgeHatch(['72', '3', '10', '0', '20', '0', '11', '10', '21', '0', '40', '0.5', '50', '0', '51', '90', '73', '0'])
  );
  const loop = hatch.loops[0];
  near(loop[0].x, 10, 'start x');
  near(loop[0].y, 0, 'start y');
  near(loop[loop.length - 1].x, 0, 'end x');
  near(loop[loop.length - 1].y, -5, 'end y');
  assert.ok(loop.every((p) => p.x >= -1e-9 && p.y <= 1e-9), 'every point in the lower-right quadrant');
});

test('elliptic edge angles are geometric angles, turned into ellipse parameters', () => {
  // 45° on an ellipse with axes 10 and 5 is where the ray at 45° meets it: x = y = 10*5/sqrt(10²+5²)
  const [hatch] = scanHatches(
    edgeHatch(['72', '3', '10', '0', '20', '0', '11', '10', '21', '0', '40', '0.5', '50', '0', '51', '45', '73', '1'])
  );
  const end = hatch.loops[0][hatch.loops[0].length - 1];
  const r = (10 * 5) / Math.sqrt(10 * 10 + 5 * 5);
  near(end.x, r, 'end x');
  near(end.y, r, 'end y');
});
