import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, applyToPoint, determinant, extrusionMatrix } from '../src/dxf/matrix';
import { parseDxf } from '../src/dxf/parseDxf';

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

const dxf = (...lines: string[]) => lines.join('\n');

test('the default extrusion changes nothing', () => {
  assert.deepEqual(extrusionMatrix(undefined), IDENTITY);
  assert.deepEqual(extrusionMatrix({ x: 0, y: 0, z: 1 }), IDENTITY);
});

test('a flipped extrusion mirrors the X axis', () => {
  const m = extrusionMatrix({ x: 0, y: 0, z: -1 });

  const point = applyToPoint(m, { x: 10, y: 5 });
  near(point.x, -10);
  near(point.y, 5);
  assert.ok(determinant(m) < 0, 'a mirror must invert orientation');
});

test('the arbitrary axis algorithm keeps the basis orthonormal', () => {
  for (const extrusion of [
    { x: 0, y: 0, z: -1 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0.3, y: -0.5, z: 0.81 },
    { x: 0, y: 0, z: -5 },
  ]) {
    const m = extrusionMatrix(extrusion);
    for (const value of [m.a, m.b, m.c, m.d]) {
      assert.ok(Number.isFinite(value), `NaN leaked out for ${JSON.stringify(extrusion)}`);
    }
    // The two columns stay perpendicular, so the transform never shears
    near(m.a * m.c + m.b * m.d, 0, 1e-12);
  }
});

test('a non-unit extrusion is normalised rather than scaling the drawing', () => {
  const m = extrusionMatrix({ x: 0, y: 0, z: -8 });
  near(Math.hypot(m.a, m.b), 1, 1e-12);
  near(Math.hypot(m.c, m.d), 1, 1e-12);
});

/**
 * The regression this guards: AutoCAD's MIRROR command usually leaves a block's
 * geometry alone and flips the INSERT's extrusion to (0,0,-1) instead. The
 * insertion point and rotation are then written in that tilted coordinate
 * system, so reading them as world coordinates puts every mirrored block —
 * doors, sanitary fittings, furniture — on the wrong side of the drawing.
 */
test('a MIRRORed INSERT lands on the correct side of the drawing', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'MARK', '10', '0.0', '20', '0.0', '30', '0.0',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '30', '0.0', '11', '1.0', '21', '0.0', '31', '0.0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'MARK',
    '10', '10.0', '20', '0.0', '30', '0.0',
    '50', '90.0',
    '210', '0.0', '220', '0.0', '230', '-1.0',
    '0', 'ENDSEC', '0', 'EOF', ''
  );

  const entities = parseDxf(text).pages[0].entities;
  const line = entities.find((e) => e.type === 'LINE');
  assert.ok(line && line.type === 'LINE', 'the block line should be expanded');

  // Read naively the insert sits at x = +10; the mirrored OCS puts it at -10.
  near(line.start.x, -10, 1e-9);
  near(line.start.y, 0, 1e-9);
  near(line.end.x, -10, 1e-9);
  near(line.end.y, 1, 1e-9);
});

test('an INSERT with the default extrusion is unaffected by the correction', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'MARK', '10', '0.0', '20', '0.0', '30', '0.0',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '30', '0.0', '11', '1.0', '21', '0.0', '31', '0.0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'MARK',
    '10', '10.0', '20', '0.0', '30', '0.0',
    '50', '90.0',
    '0', 'ENDSEC', '0', 'EOF', ''
  );

  const line = parseDxf(text).pages[0].entities.find((e) => e.type === 'LINE');
  assert.ok(line && line.type === 'LINE');

  near(line.start.x, 10, 1e-9);
  near(line.start.y, 0, 1e-9);
  near(line.end.x, 10, 1e-9);
  near(line.end.y, 1, 1e-9);
});
