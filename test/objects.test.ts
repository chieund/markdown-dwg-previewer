import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parseDxf';

const dxf = (...lines: string[]) => lines.join('\n');

/** A door block (two lines) inside a frame block, placed once with attributes. */
const doorDrawing = () =>
  dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'DOOR', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '0', '21', '1', '31', '0',
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'FRAME', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'INSERT', '8', '0', '2', 'DOOR', '10', '0', '20', '0', '30', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'A0', '8', 'WALLS', '10', '50', '20', '50', '30', '0', '11', '60', '21', '50', '31', '0',
    '0', 'INSERT', '5', 'B1', '8', 'DOORS', '66', '1', '2', 'FRAME', '10', '10', '20', '20', '30', '0',
    '41', '2', '42', '3', '50', '90',
    '0', 'ATTRIB', '5', 'C1', '8', '0', '10', '10', '20', '20', '30', '0', '40', '1', '1', 'D-101', '2', 'TAG', '70', '0',
    '0', 'ATTRIB', '5', 'C2', '8', '0', '10', '10', '20', '20', '30', '0', '40', '1', '1', 'ACME', '2', 'MAKER', '70', '1',
    '0', 'SEQEND', '5', 'C3', '8', '0',
    '0', 'TEXT', '5', 'D1', '8', 'TEXT', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'LIVING ROOM',
    '0', 'ENDSEC',
    '0', 'EOF'
  );

test('every drawn entity points at the top-level object it came from', () => {
  const parsed = parseDxf(doorDrawing());
  const entities = parsed.pages[0].entities;

  for (const entity of entities) {
    assert.equal(typeof entity.obj, 'number', `missing obj on ${JSON.stringify(entity)}`);
  }
  // Both door lines, two blocks deep, belong to the outermost INSERT
  const insert = parsed.objects.findIndex((o) => o.handle === 'B1');
  const doorLines = entities.filter((e) => e.type === 'LINE' && e.layer === 'DOORS');
  assert.equal(doorLines.length, 2);
  assert.ok(doorLines.every((e) => e.obj === insert));
});

test('an INSERT object records its block, placement and attributes', () => {
  const insert = parseDxf(doorDrawing()).objects.find((o) => o.handle === 'B1');

  assert.equal(insert?.type, 'INSERT');
  assert.equal(insert?.layer, 'DOORS');
  assert.equal(insert?.block, 'FRAME');
  assert.deepEqual(insert?.position, { x: 10, y: 20 });
  assert.equal(insert?.rotation, 90);
  assert.deepEqual(insert?.scale, { x: 2, y: 3 });
  assert.deepEqual(insert?.attributes, [
    { tag: 'TAG', value: 'D-101' },
    { tag: 'MAKER', value: 'ACME', hidden: true },
  ]);
  assert.equal(insert?.page, 0);
});

test('a drawn attribute belongs to its INSERT, so clicking the tag selects the door', () => {
  const parsed = parseDxf(doorDrawing());
  const insert = parsed.objects.findIndex((o) => o.handle === 'B1');
  const tag = parsed.pages[0].entities.find((e) => e.type === 'TEXT' && e.text === 'D-101');

  assert.equal(tag?.obj, insert);
});

test('a text object carries its content', () => {
  const text = parseDxf(doorDrawing()).objects.find((o) => o.handle === 'D1');
  assert.equal(text?.type, 'TEXT');
  assert.equal(text?.text, 'LIVING ROOM');
});

test('objects on a paper sheet name that sheet as their page', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'M1', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'LINE', '5', 'P1', '67', '1', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);

  assert.equal(parsed.objects.find((o) => o.handle === 'M1')?.page, 0);
  assert.equal(parsed.objects.find((o) => o.handle === 'P1')?.page, 1);
  assert.equal(parsed.pages[1].name, 'Paper Space');
});

test('a hatch inside a block belongs to the INSERT that places it', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'FILL', '8', '0', '10', '0', '20', '0', '30', '0',
    '0', 'HATCH', '5', 'H9', '8', '0', '10', '0', '20', '0', '30', '0', '2', 'SOLID', '70', '1', '71', '0', '91', '1',
    '92', '2', '72', '0', '73', '1', '93', '4',
    '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10', '10', '0', '20', '10',
    '97', '0', '75', '0', '76', '1', '98', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '5', 'I9', '8', '0', '2', 'FILL', '10', '0', '20', '0', '30', '0',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);
  const hatch = parsed.pages[0].entities.find((e) => e.type === 'HATCH');
  assert.equal(hatch?.obj, parsed.objects.findIndex((o) => o.handle === 'I9'));
});

test('an attribute with an empty value is still listed, but nothing is drawn for it', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '5', 'B1', '8', '0', '66', '1', '2', 'NOPE', '10', '0', '20', '0', '30', '0',
    '0', 'ATTRIB', '5', 'C1', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', '', '2', 'COST', '70', '0',
    '0', 'SEQEND', '8', '0',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);
  assert.deepEqual(parsed.objects.find((o) => o.handle === 'B1')?.attributes, [{ tag: 'COST', value: '' }]);
  assert.equal(parsed.pages[0].entities.filter((e) => e.type === 'TEXT').length, 0);
});

test('objects that draw nothing are marked, so search can leave them out', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'L1', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'LINE', '5', 'L2', '8', '0', '60', '1', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);
  assert.equal(parsed.objects.find((o) => o.handle === 'L1')?.empty, undefined);
  assert.equal(parsed.objects.find((o) => o.handle === 'L2')?.empty, true);
});

test('an R12 attribute (no handles anywhere) still belongs to the INSERT before it', () => {
  const text = dxf(
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', 'DOORS', '66', '1', '2', 'NOPE', '10', '0', '20', '0', '30', '0',
    '0', 'ATTRIB', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '1', 'A1', '2', 'TAG', '70', '0',
    '0', 'SEQEND', '8', '0',
    '0', 'ENDSEC', '0', 'EOF'
  );
  const parsed = parseDxf(text);
  const insert = parsed.objects.findIndex((o) => o.type === 'INSERT');
  assert.equal(parsed.objects[insert].handle, undefined, 'dxf-parser\'s made-up handles are not real handles');
  assert.deepEqual(parsed.objects[insert].attributes, [{ tag: 'TAG', value: 'A1' }]);
  assert.equal(parsed.pages[0].entities.find((e) => e.type === 'TEXT')?.obj, insert);
});
