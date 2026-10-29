import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parseDxf';
import type { DxfEntity, TextEntity } from '../src/shared/types';

const dxf = (...lines: string[]) => lines.join('\n');

/**
 * A vertical 5300 dimension the way AutoCAD writes it: the DIMENSION entity
 * names an anonymous block holding what it draws — dimension and extension
 * lines, an arrowhead, the text as MTEXT turned by its direction vector — plus
 * definition points on DEFPOINTS, which AutoCAD never plots.
 */
const verticalDimension = ({ withBlock = true, layer = 'DIMS' } = {}) =>
  dxf(
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER',
    '0', 'LAYER', '2', 'DIMS', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'DEFPOINTS', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    ...(withBlock
      ? [
          '0', 'BLOCK', '2', '*D1', '70', '1', '10', '0', '20', '0', '30', '0',
          // Dimension line, then the two extension lines
          '0', 'LINE', '8', '0', '62', '0', '10', '1000', '20', '0', '30', '0', '11', '1000', '21', '5300', '31', '0',
          '0', 'LINE', '8', '0', '62', '0', '10', '0', '20', '0', '30', '0', '11', '1100', '21', '0', '31', '0',
          '0', 'LINE', '8', '0', '62', '0', '10', '0', '20', '5300', '30', '0', '11', '1100', '21', '5300', '31', '0',
          // An arrowhead
          '0', 'SOLID', '8', '0', '62', '0', '10', '1000', '20', '0', '30', '0', '11', '980', '21', '100', '31', '0',
          '12', '1020', '22', '100', '32', '0', '13', '1020', '23', '100', '33', '0',
          // The text, turned upright by its direction vector
          '0', 'MTEXT', '8', '0', '62', '0', '10', '950', '20', '2650', '30', '0', '40', '300', '71', '5',
          '1', '\\A1;5300', '11', '0', '21', '1', '31', '0',
          // Definition points
          '0', 'POINT', '8', 'DEFPOINTS', '10', '0', '20', '0', '30', '0',
          '0', 'POINT', '8', 'DEFPOINTS', '10', '0', '20', '5300', '30', '0',
          '0', 'ENDBLK',
        ]
      : []),
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'DIMENSION', '5', 'D1', '8', layer, '2', '*D1',
    '10', '1000', '20', '5300', '30', '0', '11', '950', '21', '2650', '31', '0', '70', '33',
    '13', '0', '23', '0', '33', '0', '14', '0', '24', '5300', '34', '0', '42', '5300',
    '0', 'ENDSEC', '0', 'EOF'
  );

const entitiesOf = (text: string): DxfEntity[] => parseDxf(text).pages[0].entities;

test('a dimension draws the lines, arrowhead and text AutoCAD stored for it', () => {
  const entities = entitiesOf(verticalDimension());
  assert.deepEqual(
    entities.map((e) => e.type),
    ['LINE', 'LINE', 'LINE', 'POLYLINE', 'TEXT'],
    'its block, not a reconstruction, and no definition points'
  );
  // Layer 0 and BYBLOCK inside the block follow the dimension
  for (const entity of entities) {
    assert.equal(entity.layer, 'DIMS');
    assert.equal(entity.color, '#ff0000');
    assert.equal(entity.obj, 0, 'every piece selects the dimension');
  }
  const label = entities.find((e): e is TextEntity => e.type === 'TEXT')!;
  assert.equal(label.text, '5300');
  assert.equal(label.height, 300, 'the text height the dimension style gave it, not a fallback');
  assert.equal(Math.round(label.rotation), 90, 'upright, along a vertical dimension');
});

test('a dimension is not linework: it adds nothing to the quantities', () => {
  const [dimension] = parseDxf(verticalDimension()).objects;
  assert.equal(dimension.type, 'DIMENSION');
  assert.equal(dimension.text, '5300');
  assert.equal(dimension.length, undefined);
  assert.equal(dimension.area, undefined);
  assert.equal(dimension.empty, undefined);
});

test('a dimension without its block still shows its value', () => {
  const entities = entitiesOf(verticalDimension({ withBlock: false }));
  const dimension = entities.find((e) => e.type === 'DIMENSION');
  assert.ok(dimension && dimension.type === 'DIMENSION');
  assert.equal(dimension.text, '5300');
});

test('MTEXT follows its direction vector, else group 50 in degrees', () => {
  const mtext = (...extra: string[]) =>
    entitiesOf(
      dxf(
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'MTEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'NOTE', ...extra,
        '0', 'ENDSEC', '0', 'EOF'
      )
    )[0] as TextEntity;
  assert.equal(Math.round(mtext('11', '0', '21', '1', '31', '0').rotation), 90);
  assert.equal(Math.round(mtext('11', '-1', '21', '0', '31', '0').rotation), 180);
  // The DXF reference says radians; AutoCAD and ezdxf write degrees
  assert.equal(Math.round(mtext('50', '90').rotation), 90);
  // The direction vector wins over group 50
  assert.equal(Math.round(mtext('50', '45', '11', '0', '21', '1', '31', '0').rotation), 90);
  assert.equal(mtext().rotation, 0);
});

test('Find and the inspector read a dimension as it is drawn, not its raw measurement', () => {
  // An imperial dimension: 42 drawing units, drawn as 3'-6"
  const text = verticalDimension().replace('\\A1;5300', '\\A1;3\'-6"').replace('42\n5300', '42\n42');
  const [dimension] = parseDxf(text).objects;
  assert.equal(dimension.text, '3\'-6"');
});

test('a dimension whose block holds only definition points still shows its value', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', '*D1', '70', '1', '10', '0', '20', '0', '30', '0',
    '0', 'POINT', '8', 'DEFPOINTS', '10', '0', '20', '0', '30', '0',
    '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'DIMENSION', '8', 'DIMS', '2', '*D1', '10', '0', '20', '0', '30', '0',
    '11', '5', '21', '5', '31', '0', '70', '32', '42', '120',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const [only] = entitiesOf(text);
  assert.ok(only && only.type === 'DIMENSION');
  assert.equal(only.text, '120');
});

test('a dimension with a tolerance reads as all of its text', () => {
  // A second MTEXT beside the value, as AutoCAD writes a tolerance
  const text = verticalDimension().replace(
    '\\A1;5300\n11\n0\n21\n1\n31\n0\n', '\\A1;5300\n11\n0\n21\n1\n31\n0\n0\nMTEXT\n8\n0\n10\n1100\n20\n2650\n30\n0\n40\n150\n1\n+5\n');
  const [dimension] = parseDxf(text).objects;
  assert.equal(dimension.text, '5300 +5');
});

const dimensionRecord = (extra: string[] = [], text = '') =>
  [
    '0', 'DIMENSION', '8', 'DIMS', '2', '*D1', '10', '0', '20', '0', '30', '0',
    '11', '950', '21', '2650', '31', '0', '70', '33', ...(text ? ['1', text] : []), '42', '5300', ...extra,
  ];

test('a dimension inside a block is listed against its INSERT', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'ELEV', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    ...dimensionRecord(),
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', '*D1', '70', '1', '10', '0', '20', '0', '30', '0',
    '0', 'MTEXT', '8', '0', '10', '950', '20', '2650', '30', '0', '40', '300', '1', '5300',
    '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0',
    '0', 'INSERT', '8', '0', '2', 'ELEV', '10', '100', '20', '0', '30', '0', '41', '2', '42', '2', '43', '2',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);
  assert.equal(parsed.dimensions?.length, 1);
  const [info] = parsed.dimensions!;
  assert.equal(info.obj, 1, 'the INSERT, not the dimension');
  assert.equal(info.text, '5300');
  assert.equal(info.layer, 'DIMS');
  assert.equal(info.position?.x, 100 + 2 * 950);
  assert.equal(info.position?.y, 2 * 2650);
});

test('top-level dimensions are listed with their own object', () => {
  const parsed = parseDxf(verticalDimension());
  assert.equal(parsed.dimensions?.length, 1);
  const [info] = parsed.dimensions!;
  assert.equal(info.obj, 0);
  assert.equal(info.text, parsed.objects[0].text, 'the list and the object never disagree');
  assert.deepEqual(info.position, { x: 950, y: 2650 });
});

test('viewport collection adds no dimensions', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    ...dimensionRecord(),
    '0', 'LINE', '67', '1', '8', 'BORDER', '10', '0', '20', '0', '30', '0', '11', '100', '21', '0', '31', '0',
    '0', 'VIEWPORT', '67', '1', '8', '0', '10', '50', '20', '50', '30', '0', '40', '20', '41', '20',
    '68', '1', '69', '2', '12', '950', '22', '2650', '45', '10',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);
  assert.equal(parsed.pages[1].viewports?.length, 1, 'the viewport shows the dimension');
  assert.equal(parsed.dimensions?.length, 1, 'but it is listed once, from the model');
});

test('measurement is kept beside an overridden text', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'DIMENSION', '8', 'DIMS', '10', '0', '20', '0', '30', '0',
    '11', '5', '21', '5', '31', '0', '70', '32', '1', 'L=25m', '42', '25000',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const [info] = parseDxf(text).dimensions!;
  assert.equal(info.text, 'L=25m');
  assert.equal(info.measurement, 25000);
});

test('a dimension without a text position uses its anchor point', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'DIMENSION', '8', 'DIMS', '10', '40', '20', '60', '30', '0', '70', '32', '42', '120',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const [info] = parseDxf(text).dimensions!;
  assert.deepEqual(info.position, { x: 40, y: 60 });
});

test('a dimension with no position at all is still listed', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'DIMENSION', '8', 'DIMS', '70', '32', '42', '120',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const [info] = parseDxf(text).dimensions!;
  assert.equal(info.measurement, 120);
  assert.equal(info.position, undefined);
});
