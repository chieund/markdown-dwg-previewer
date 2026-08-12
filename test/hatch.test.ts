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
