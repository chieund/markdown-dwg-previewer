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

test('MTEXT follows its direction vector, and code 50 is radians', () => {
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
  assert.equal(Math.round(mtext('50', String(Math.PI / 2)).rotation), 90);
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
