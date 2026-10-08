import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parseDxf';
import { scanBlockNames } from '../src/dxf/blockNames';
import {
  BulgeVertex,
  arcLength,
  circleMeasure,
  hatchArea,
  pathLength,
  polylineMeasure,
  polygonArea,
  polygonMeasure,
  scaleMeasure,
} from '../src/dxf/measure';
import { Matrix2D, IDENTITY } from '../src/dxf/matrix';
import type { ObjectInfo } from '../src/shared/types';

const near = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(
    Math.abs((actual ?? NaN) - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );

const relative = (actual: number | undefined, expected: number, fraction = 0.001) =>
  assert.ok(
    Math.abs((actual ?? NaN) - expected) <= Math.abs(expected) * fraction,
    `expected ${actual} to be within ${fraction * 100}% of ${expected}`
  );

const dxf = (...lines: string[]) => lines.join('\n');

/** A LAYER table entry; a negative colour means the layer is switched off. */
const layer = (name: string, color: number) => ['0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS'];

const withLayers = (layers: string[][], ...body: string[]) =>
  dxf('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', ...layers.flat(), '0', 'ENDTAB', '0', 'ENDSEC', ...body, '0', 'EOF');

const entities = (...body: string[]) => ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC'];

/** Header variable `$INSUNITS`, as the drawing declares its unit. */
const withUnits = (insunits: number, ...body: string[]) =>
  dxf(
    '0', 'SECTION', '2', 'HEADER',
    '9', '$INSUNITS', '70', String(insunits),
    '0', 'ENDSEC',
    ...body,
    '0', 'EOF'
  );

const lwpolyline = (
  vertices: { x: number; y: number; bulge?: number }[],
  { closed = false, layerName = '0', handle }: { closed?: boolean; layerName?: string; handle?: string } = {}
) => [
  '0', 'LWPOLYLINE', ...(handle ? ['5', handle] : []), '8', layerName,
  '90', String(vertices.length), '70', closed ? '1' : '0',
  ...vertices.flatMap((v) => ['10', String(v.x), '20', String(v.y), ...(v.bulge ? ['42', String(v.bulge)] : [])]),
];

const insert = (name: string, { xScale = 1, yScale = 1, layerName = '0', handle }: {
  xScale?: number; yScale?: number; layerName?: string; handle?: string;
} = {}) => [
  '0', 'INSERT', ...(handle ? ['5', handle] : []), '8', layerName, '2', name,
  '10', '0', '20', '0', '30', '0', '41', String(xScale), '42', String(yScale),
];

const block = (name: string, ...body: string[]) =>
  ['0', 'BLOCK', '2', name, '8', '0', '10', '0', '20', '0', '30', '0', ...body, '0', 'ENDBLK'];

const blocksSection = (...blocks: string[][]) => ['0', 'SECTION', '2', 'BLOCKS', ...blocks.flat(), '0', 'ENDSEC'];

const modelObjects = (text: string): ObjectInfo[] => parseDxf(text).objects;

// ── Exact geometry ────────────────────────────────────────────────────────

test('a circle measures its circumference and its disc', () => {
  const measure = circleMeasure(2);
  near(measure.length, 2 * Math.PI * 2);
  near(measure.area, Math.PI * 4);
});

test('an arc measures radius × its counter-clockwise sweep', () => {
  near(arcLength(3, 0, Math.PI / 2), 3 * Math.PI / 2);
  // DXF arcs run counter-clockwise, so 300° → 30° sweeps 90°, not 270°.
  near(arcLength(3, (5 * Math.PI) / 3, Math.PI / 6), 3 * Math.PI / 2);
  // Equal angles are a full turn, as AutoCAD draws them.
  near(arcLength(1, 1, 1), 2 * Math.PI);
  // A corrupt angle must not hang the parser.
  assert.ok(Number.isFinite(arcLength(1, -1e300, 0)));
});

test('a bulge of 1 is a semicircle: the arc is πr long and encloses πr²/2', () => {
  // A closed two-point polyline: the bulge arc out and the diameter back.
  const measure = polylineMeasure([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }], true);
  near(measure.length, Math.PI + 2, 1e-9);
  near(measure.area, (Math.PI * 1 * 1) / 2, 1e-9);
});

test('a closed polyline measures the square plus the semicircle bulging out of one edge', () => {
  const square: BulgeVertex[] = [
    { x: 0, y: 0, bulge: 1 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const measure = polylineMeasure(square, true);
  near(measure.length, 3 + Math.PI * 0.5, 1e-9);
  near(measure.area, 1 + (Math.PI * 0.25) / 2, 1e-9);
});

test('a clockwise bulge takes the area away again', () => {
  const measure = polylineMeasure([{ x: 0, y: 0, bulge: -1 }, { x: 2, y: 0 }], true);
  near(measure.area, (Math.PI * 1 * 1) / 2, 1e-9);
});

test('an open polyline has length but no area', () => {
  const measure = polylineMeasure([{ x: 0, y: 0 }, { x: 3, y: 4 }], false);
  near(measure.length, 5);
  near(measure.area, 0);
});

test('a hatch with a hole covers the outer loop less the inner one', () => {
  const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole = [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }];
  near(hatchArea([outer, hole]), 100 - 16);
});

test('the area of a hatch does not depend on the direction its loops are listed in', () => {
  const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole = [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }];
  // A mirrored block flips every loop over; the covered area is unchanged.
  const flipped = (loop: { x: number; y: number }[]) => [...loop].reverse().map((p) => ({ x: -p.x, y: p.y }));
  near(hatchArea([flipped(outer), flipped(hole)]), 100 - 16);
});

test('a hatch loop with fewer than three points encloses nothing', () => {
  near(hatchArea([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]), 0);
});

test('polygon helpers ignore degenerate input', () => {
  near(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 0);
  near(polygonArea([{ x: 0, y: 0 }, { x: 0, y: 0 }]), 0);
  near(pathLength([{ x: 0, y: 0 }], true), 0);
});

test('a closed ring measures the same whichever way it is listed', () => {
  const clockwise = [{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 0 }];
  const counterClockwise = [...clockwise].reverse();
  const one = polygonMeasure(clockwise, true).area ?? NaN;
  near(one, polygonMeasure(counterClockwise, true).area ?? NaN);
  near(one, 4);
});

// ── Scaling ───────────────────────────────────────────────────────────────

const uniform = (factor: number): Matrix2D => ({ a: factor, b: 0, c: 0, d: factor, e: 0, f: 0 });

test('a uniform scale multiplies lengths once and areas twice', () => {
  const scaled = scaleMeasure({ length: 5, area: 7, hatchArea: 3 }, uniform(2));
  near(scaled.length, 10);
  near(scaled.area, 28);
  near(scaled.hatchArea, 12);
});

test('a mirror changes no lengths and no areas', () => {
  const mirrored: Matrix2D = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const scaled = scaleMeasure({ length: 5, area: 7 }, mirrored);
  near(scaled.length, 5);
  near(scaled.area, 7);
});

test('a non-uniform scale is left to the caller, which measures the sampled shape', () => {
  const stretched: Matrix2D = { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 };
  assert.deepEqual(scaleMeasure({ length: 5, area: 7 }, stretched), { length: 5, area: 7 });
  near(scaleMeasure({ length: 5 }, IDENTITY).length, 5);
});

// ── Through the parser ────────────────────────────────────────────────────

test('a LINE measures its length in world units', () => {
  const text = withLayers([layer('0', 7)], ...entities('0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '3', '21', '4', '31', '0'));
  near(modelObjects(text)[0].length, 5);
});

test('a CIRCLE measures circumference and area, an ARC only its length', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities(
      '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1',
      '0', 'ARC', '8', '0', '10', '0', '20', '0', '30', '0', '40', '2', '50', '0', '51', '90'
    )
  );
  const [circle, arc] = modelObjects(text);
  near(circle.length, 2 * Math.PI);
  near(circle.area, Math.PI);
  near(arc.length, Math.PI);
  assert.equal(arc.area, undefined);
});

test('an ARC crossing 0° measures the short way round, the way it is drawn', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'ARC', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '50', '300', '51', '30')
  );
  near(modelObjects(text)[0].length, Math.PI / 2);
});

test('a closed LWPOLYLINE measures its perimeter and its enclosed area', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities(...lwpolyline([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], { closed: true }))
  );
  const [polyline] = modelObjects(text);
  near(polyline.length, 14);
  near(polyline.area, 12);
});

test('text and points measure nothing', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities(
      '0', 'TEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'HELLO',
      '0', 'POINT', '8', '0', '10', '0', '20', '0', '30', '0'
    )
  );
  const [label, point] = modelObjects(text);
  assert.equal(label.length, undefined);
  assert.equal(point.area, undefined);
});

test('a SOLID measures its outline as an area', () => {
  // DXF stores SOLID corners in the order 1, 2, 4, 3 — writing them in
  // drawing order here would draw a bow tie instead of a quad.
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'SOLID', '8', '0', '10', '0', '20', '0', '30', '0', '11', '2', '21', '0', '31', '0', '12', '0', '22', '2', '32', '0', '13', '2', '23', '2', '33', '0')
  );
  const [solid] = modelObjects(text);
  near(solid.area, 4);
  near(solid.length, 8);
});

test('an ELLIPSE measures its sampled outline, within a tenth of a percent', () => {
  // Major axis end (3,0), axis ratio 1/2 → an ellipse of 3 × 1.5.
  const text = withLayers(
    [layer('0', 7)],
    ...entities('0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '3', '21', '0', '31', '0', '40', '0.5', '41', '0', '42', '6.283185307179586')
  );
  const [ellipse] = modelObjects(text);
  relative(ellipse.area, Math.PI * 3 * 1.5);
  relative(ellipse.length, perimeterOfEllipse(3, 1.5));
});

/** Ramanujan's approximation, which is well inside a tenth of a percent. */
function perimeterOfEllipse(a: number, b: number): number {
  const h = ((a - b) ** 2) / ((a + b) ** 2);
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

test('a hatch measures its own area, not the polyline it fills', () => {
  const hatchBody = [
    '0', 'HATCH', '8', '0', '10', '0', '20', '0', '30', '0', '2', 'SOLID', '70', '1', '71', '0', '91', '1',
    '92', '2', '72', '0', '73', '1', '93', '4',
    '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10', '10', '0', '20', '10',
    '97', '0', '75', '0', '76', '1', '98', '0',
  ];
  const text = withLayers([layer('0', 7)], ...entities(...hatchBody));
  const [hatch] = modelObjects(text);
  near(hatch.hatchArea, 100);
  assert.equal(hatch.area, undefined);
  assert.equal(hatch.length, undefined);
});

test('an INSERT measures the geometry it expands to, at its own scale', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...blocksSection(block('ROOM', ...lwpolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { closed: true }))),
    ...entities(...insert('ROOM'))
  );
  const [room] = modelObjects(text);
  near(room.length, 4);
  near(room.area, 1);
});

test('doubling an INSERT doubles its length and quadruples its area', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...blocksSection(block('ROOM', ...lwpolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { closed: true }))),
    ...entities(...insert('ROOM', { xScale: 2, yScale: 2 }))
  );
  const [room] = modelObjects(text);
  near(room.length, 8);
  near(room.area, 4);
});

test('an INSERT array measures every copy', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...blocksSection(block('ROOM', ...lwpolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }]))),
    ...entities(...insert('ROOM'), '70', '3', '71', '1', '44', '5')
  );
  const [room] = modelObjects(text);
  near(room.length, 3);
});

test('a non-uniform INSERT scale measures the stretched shape, not the original', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...blocksSection(block('ROOM', ...lwpolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { closed: true }))),
    ...entities(...insert('ROOM', { xScale: 3, yScale: 1 }))
  );
  const [room] = modelObjects(text);
  near(room.area, 3);
  near(room.length, 8);
});

test('a hatch inside a block measures onto the INSERT, not onto a hidden child', () => {
  const hatchBody = [
    '0', 'HATCH', '8', '0', '10', '0', '20', '0', '30', '0', '2', 'SOLID', '70', '1', '71', '0', '91', '1',
    '92', '2', '72', '0', '73', '1', '93', '4',
    '10', '0', '20', '0', '10', '4', '20', '0', '10', '4', '20', '4', '10', '0', '20', '4',
    '97', '0', '75', '0', '76', '1', '98', '0',
  ];
  const text = withLayers(
    [layer('0', 7)],
    ...blocksSection(block('TILE', ...hatchBody)),
    ...entities(...insert('TILE', { xScale: 2, yScale: 2 }))
  );
  const objects = modelObjects(text);
  assert.equal(objects.length, 1, 'the hatch belongs to the block, so the INSERT is the only object');
  // 4 × 4 scaled by 2 on both axes
  near(objects[0].hatchArea, 64);
});

test('geometry collected for a viewport is not measured a second time', () => {
  const text = withLayers(
    [layer('0', 7)],
    ...entities(
      // Model: a line that falls inside the viewport's window
      '0', 'LINE', '5', 'IN', '8', 'MODEL', '10', '0', '20', '0', '30', '0', '11', '3', '21', '4', '31', '0',
      // Sheet: a border and a viewport showing 10 units around the origin
      '0', 'LINE', '67', '1', '8', 'BORDER', '10', '0', '20', '0', '30', '0', '11', '100', '21', '0', '31', '0',
      '0', 'VIEWPORT', '67', '1', '8', '0', '10', '50', '20', '50', '30', '0', '40', '20', '41', '20',
      '68', '1', '69', '2', '12', '0', '22', '0', '45', '10'
    )
  );
  const parsed = parseDxf(text);
  assert.equal(parsed.pages[1].viewports?.[0].entities.length, 1, 'the viewport does show the line');
  near(parsed.objects.find((object) => object.handle === 'IN')?.length, 5);
});

// ── Units ────────────────────────────────────────────────────────────────

test('$INSUNITS is read from the header', () => {
  const text = withUnits(4, ...entities('0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0'));
  assert.equal(parseDxf(text).units, 4);
});

test('a drawing that declares no unit reports none', () => {
  const text = withLayers([layer('0', 7)], ...entities('0', 'POINT', '8', '0', '10', '0', '20', '0', '30', '0'));
  assert.equal(parseDxf(text).units, undefined);
});

test('a unitless drawing ($INSUNITS 0) reports none', () => {
  const text = withUnits(0, ...entities('0', 'POINT', '8', '0', '10', '0', '20', '0', '30', '0'));
  assert.equal(parseDxf(text).units, undefined);
});

// ── Dynamic block names ──────────────────────────────────────────────────

/**
 * A file whose OBJECTS section declares `*B24` as a representation of `Window`
 * — the shape AutoCAD writes for a dynamic block.
 */
const withBlockRecords = (represented: string, ...body: string[]) =>
  dxf(
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', ...layer('0', 7), '0', 'ENDTAB', '0', 'ENDSEC',
    ...body,
    '0', 'SECTION', '2', 'OBJECTS',
    '0', 'TABLE', '2', 'BLOCK_RECORD',
    '5', 'C', '2', 'BLOCK_RECORD_TABLE', '340', '0',
    '0', 'BLOCK_RECORD', '5', 'A1', '2', 'Window', '340', '11',
    '0', 'BLOCK_RECORD', '5', 'B24', '2', '*B24', '340', '22',
    '1001', 'AcDbRepBTag', '1000', '',
    '1001', 'AcDbBlockRepBTag', '1005', represented,
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'EOF'
  );

test('an anonymous dynamic block is listed under the block it stands for', () => {
  assert.deepEqual(scanBlockNames(withBlockRecords('A1')), { '*B24': 'Window' });
});

test('an INSERT of a dynamic block reports the real block name', () => {
  const text = withBlockRecords('A1', ...entities(...insert('*B24', { handle: 'I1' })));
  const objects = modelObjects(text);
  assert.equal(objects.length, 1, `expected one object, got ${JSON.stringify(objects)}`);
  assert.equal(objects[0].block, 'Window');
});

test('a drawing without dynamic blocks needs no scan', () => {
  assert.deepEqual(scanBlockNames(dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF')), {});
});

test('an INSERT of an ordinary block keeps its own name', () => {
  const text = withLayers([layer('0', 7)], ...entities(...insert('Door-900', { handle: 'I2' })));
  assert.equal(modelObjects(text)[0].block, 'Door-900');
});

test('a representation tag pointing at nothing leaves the name alone', () => {
  assert.deepEqual(scanBlockNames(withBlockRecords('ZZ')), {});
});
test('geometry inside a block on another layer is recorded against that layer too', () => {
  const text = withLayers(
    [layer('0', 7), layer('DOORS', 1), layer('SWING', 2)],
    ...blocksSection(
      block(
        'DOOR',
        ...lwpolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }]),
        ...lwpolyline([{ x: 0, y: 0 }, { x: 0, y: 2 }], { layerName: 'SWING' })
      )
    ),
    ...entities(...insert('DOOR', { layerName: 'DOORS' }))
  );
  const [door] = modelObjects(text);
  near(door.length, 3);
  // Layer-0 geometry is drawn on the INSERT's own layer, so only SWING is a part
  assert.deepEqual(Object.keys(door.parts ?? {}), ['SWING']);
  near(door.parts?.SWING.length, 2);
});

test('an object drawn entirely on its own layer records no parts', () => {
  const text = withLayers([layer('0', 7)], ...entities(...lwpolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }])));
  assert.equal(modelObjects(text)[0].parts, undefined);
});
