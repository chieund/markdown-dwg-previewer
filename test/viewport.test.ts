import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawViewport, scanViewports, viewportTransform } from '../src/dxf/viewport';
import { applyToPoint } from '../src/dxf/matrix';

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

const dxf = (...lines: string[]) => lines.join('\n');

const viewport = (overrides: Partial<RawViewport> = {}): RawViewport => ({
  blockName: null,
  paper: { x: 100, y: 50, width: 40, height: 20 },
  viewCenter: { x: 1000, y: 2000 },
  viewHeight: 200,
  twist: 0,
  frozenLayerHandles: [],
  ...overrides,
});

test('the model point at the view centre lands in the middle of the window', () => {
  const m = viewportTransform(viewport());
  const placed = applyToPoint(m, { x: 1000, y: 2000 });

  near(placed.x, 100);
  near(placed.y, 50);
});

test('model distances shrink by the ratio of window height to view height', () => {
  // A 20-unit-tall window showing 200 units of model = 1:10
  const m = viewportTransform(viewport());
  const placed = applyToPoint(m, { x: 1000, y: 2100 });

  near(placed.x, 100);
  near(placed.y, 60, 1e-9);
});

test('twist rotates the model inside the window', () => {
  const m = viewportTransform(viewport({ twist: 90 }));
  const placed = applyToPoint(m, { x: 1100, y: 2000 });

  // 100 model units east of centre, twisted 90°, scaled 1:10 → 10 paper units south
  near(placed.x, 100, 1e-9);
  near(placed.y, 40, 1e-9);
});

test('scanViewports reads a viewport out of the ENTITIES section', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'VIEWPORT',
    '8', '0',
    '10', '100.0',
    '20', '50.0',
    '40', '40.0',
    '41', '20.0',
    '12', '1000.0',
    '22', '2000.0',
    '45', '200.0',
    '51', '15.0',
    '331', 'A1',
    '331', 'B2',
    '0', 'ENDSEC'
  );

  const found = scanViewports(text);

  assert.equal(found.length, 1);
  assert.equal(found[0].blockName, null);
  assert.deepEqual(found[0].paper, { x: 100, y: 50, width: 40, height: 20 });
  assert.deepEqual(found[0].viewCenter, { x: 1000, y: 2000 });
  assert.equal(found[0].viewHeight, 200);
  assert.equal(found[0].twist, 15);
  assert.deepEqual(found[0].frozenLayerHandles, ['A1', 'B2']);
});

test('the pseudo-viewport standing for the sheet itself is discarded', () => {
  // Its view centre and height match the paper exactly — rendering model space
  // through it would paste the drawing on top of the sheet.
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'VIEWPORT',
    '10', '100.0',
    '20', '50.0',
    '40', '40.0',
    '41', '20.0',
    '12', '100.0',
    '22', '50.0',
    '45', '20.0',
    '0', 'ENDSEC'
  );

  assert.deepEqual(scanViewports(text), []);
});

test('a viewport inside a block records the block that holds it', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'BLOCKS',
    '0', 'BLOCK',
    '2', '*Paper_Space0',
    '0', 'VIEWPORT',
    '10', '100.0',
    '20', '50.0',
    '40', '40.0',
    '41', '20.0',
    '12', '1000.0',
    '22', '2000.0',
    '45', '200.0',
    '0', 'ENDBLK',
    '0', 'ENDSEC'
  );

  const found = scanViewports(text);

  assert.equal(found.length, 1);
  assert.equal(found[0].blockName, '*Paper_Space0');
});

test('viewports with impossible dimensions are rejected', () => {
  const text = dxf(
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'VIEWPORT',
    '10', '100.0',
    '20', '50.0',
    '40', '0.0',
    '41', '0.0',
    '12', '1000.0',
    '22', '2000.0',
    '45', '200.0',
    '0', 'ENDSEC'
  );

  assert.deepEqual(scanViewports(text), []);
});

test('the view target offsets the view centre — a panned viewport can keep its centre at the origin', () => {
  // Real file (blocks_and_tables_-_metric.dwg): 12/22 = (-3218, -2501), 17/27 = (3361, 2671)
  const m = viewportTransform(viewport({ viewCenter: { x: -3000, y: -2000 }, target: { x: 4000, y: 4000 } }));
  const placed = applyToPoint(m, { x: 1000, y: 2000 });

  near(placed.x, 100);
  near(placed.y, 50);
});

test('scanViewports reads the view target (17/27)', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'VIEWPORT', '10', '100', '20', '50', '40', '40', '41', '20',
    '12', '-3000', '22', '-2000', '17', '4000', '27', '4000', '45', '200',
    '0', 'ENDSEC'
  );

  assert.deepEqual(scanViewports(text)[0].target, { x: 4000, y: 4000 });
});
