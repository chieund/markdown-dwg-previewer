import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureSelection, takeOff } from '../src/webview/takeoff';
import { DRAWING_UNITS, NO_VALUE, convertArea, convertLength, defaultUnit, formatArea, formatLength } from '../src/webview/units';
import { UTF8_BOM, csvField, toCsv, toTsv } from '../src/webview/table';
import type { ObjectInfo } from '../src/shared/types';

const object = (over: Partial<ObjectInfo> & Pick<ObjectInfo, 'type' | 'layer'>): ObjectInfo => ({
  page: 0,
  ...over,
});

/** Two doors on one layer, a wall and a window on others. */
const drawing: ObjectInfo[] = [
  object({ type: 'INSERT', layer: 'DOORS', block: 'Door-900', length: 2.4, area: 1.2 }),
  object({ type: 'INSERT', layer: 'DOORS', block: 'Door-900', length: 2.4 }),
  object({ type: 'INSERT', layer: 'DOORS', block: 'Door-900', length: 2.4 }),
  object({ type: 'INSERT', layer: 'WINDOWS', block: 'Window', length: 1.2 }),
  object({ type: 'LWPOLYLINE', layer: 'WALLS', length: 5, area: 2, hatchArea: 1 }),
];

const none = new Set<string>();

// ── Takeoff ──────────────────────────────────────────────────────────────

test('blocks are counted under their real name', () => {
  const { blocks } = takeOff(drawing, 0, none);
  assert.deepEqual(blocks.map((row) => [row.name, row.count]), [
    ['Door-900', 3],
    ['Window', 1],
  ]);
});

test('a block row carries the objects it counts, so the numbers can be checked', () => {
  const doors = takeOff(drawing, 0, none).blocks.find((row) => row.name === 'Door-900');
  assert.deepEqual(doors?.objects, [0, 1, 2]);
});

test('layers are listed with their object count, length, area and hatch area', () => {
  const { layers } = takeOff(drawing, 0, none);
  assert.deepEqual(layers.map((row) => [row.name, row.count]), [
    ['DOORS', 3],
    ['WALLS', 1],
    ['WINDOWS', 1],
  ]);
  const walls = layers.find((row) => row.name === 'WALLS');
  assert.equal(walls?.length, 5);
  assert.equal(walls?.area, 2);
  assert.equal(walls?.hatchArea, 1);
});

test('a layer with nothing to measure still lists its objects', () => {
  const doors = takeOff(drawing, 0, none).layers.find((row) => row.name === 'DOORS');
  assert.ok(Math.abs((doors?.length ?? 0) - 7.2) < 1e-9, `expected 7.2, got ${doors?.length}`);
  assert.equal(doors?.area, 1.2);
  assert.equal(doors?.hatchArea, 0);
});

test('hidden layers are left out — the panel measures what the screen shows', () => {
  const hidden = new Set(['DOORS']);
  const { blocks, layers, totals } = takeOff(drawing, 0, hidden);
  assert.deepEqual(blocks.map((row) => row.name), ['Window']);
  assert.deepEqual(layers.map((row) => row.name), ['WALLS', 'WINDOWS']);
  assert.equal(totals.count, 2);
  assert.equal(totals.length, 6.2);
});

test('only the page on screen is measured', () => {
  const onSheet = [object({ type: 'LWPOLYLINE', layer: 'A', length: 1, page: 1 })];
  assert.equal(takeOff(onSheet, 0, none).totals.count, 0);
  assert.equal(takeOff(onSheet, 1, none).totals.count, 1);
});

test('objects that were never drawn are not counted', () => {
  const withHidden = [...drawing, object({ type: 'INSERT', layer: 'DOORS', block: 'Door-900', empty: true })];
  assert.equal(takeOff(withHidden, 0, none).blocks.find((row) => row.name === 'Door-900')?.count, 3);
});

test('a sheet with nothing on it totals zero', () => {
  assert.deepEqual(takeOff([], 0, none).totals, { count: 0, length: 0, area: 0, hatchArea: 0 });
});

test('a selection totals its own objects, whatever layer they sit on', () => {
  assert.deepEqual(measureSelection(drawing, [0, 4]), {
    count: 2,
    length: 7.4,
    area: 3.2,
    hatchArea: 1,
  });
});

test('an empty or stale selection totals zero rather than throwing', () => {
  assert.equal(measureSelection(drawing, []).count, 0);
  assert.equal(measureSelection(drawing, [999]).count, 0);
});

// ── Units ────────────────────────────────────────────────────────────────

test('a metric drawing opens in metres and an imperial one in feet', () => {
  assert.equal(defaultUnit(6)?.id, 'm');
  assert.equal(defaultUnit(4)?.id, 'm');
  assert.equal(defaultUnit(1)?.id, 'ft');
  assert.equal(defaultUnit(2)?.id, 'ft');
});

test('a drawing that declares no unit leaves the numbers in drawing units', () => {
  assert.equal(defaultUnit(undefined), undefined);
  assert.equal(defaultUnit(99), undefined);
});

test('drawing units are converted through metres', () => {
  const metre = defaultUnit(6);
  const millimetre = defaultUnit(4);
  assert.equal(convertLength(1000, 4, metre), 1);
  assert.equal(convertLength(1, 6, metre), 1);
  // One drawing unit of an imperial file is an inch; 12 of them are a foot.
  const foot = defaultUnit(1);
  assert.ok(Math.abs(convertLength(12, 1, foot) - 1) < 1e-12);
  assert.ok(Math.abs(convertLength(1, 4, millimetre!) - 0.001) < 1e-12);
});

test('areas scale by the square of the length factor', () => {
  const metre = defaultUnit(6);
  // A 6 000 × 4 000 mm room is 24 m², not 24 000.
  assert.equal(convertArea(6000 * 4000, 4, metre), 24);
  assert.equal(convertArea(5, 6, metre), 5);
  // 144 in² is one square foot.
  assert.ok(Math.abs(convertArea(144, 1, defaultUnit(1)) - 1) < 1e-12);
  assert.equal(convertArea(42, 6, undefined), 42);
});

test('with no chosen unit the numbers stay as the file stores them', () => {
  assert.equal(convertLength(42, 6, undefined), 42);
  assert.equal(formatLength(42, undefined), `42.00 ${DRAWING_UNITS.label}`);
});

test('lengths and areas carry the unit, and areas are squared', () => {
  const metre = defaultUnit(6);
  assert.equal(formatLength(24.6, metre), '24.60 m');
  assert.equal(formatArea(41.25, metre), '41.25 m²');
});

test('nothing to report shows an em dash, not a zero', () => {
  const metre = defaultUnit(6);
  assert.equal(formatLength(0, metre), NO_VALUE);
  assert.equal(formatLength(undefined, metre), NO_VALUE);
  assert.equal(formatArea(0, metre), NO_VALUE);
});

// ── Tables ───────────────────────────────────────────────────────────────

test('tab-separated values paste as cells', () => {
  assert.equal(toTsv([['Block', 'Count'], ['Door-900', '3']]), 'Block\tCount\r\nDoor-900\t3\r\n');
});

test('a tab or newline inside a cell is flattened, so columns cannot shift', () => {
  assert.equal(toTsv([['a\tb', 'c\nd']]), 'a b\tc d\r\n');
});

test('CSV quotes only the fields that need it', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('with, comma'), '"with, comma"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
});

test('CSV ends every line with CRLF, the way Excel writes files', () => {
  assert.equal(toCsv([['Layer', 'Length (m)'], ['WALLS', '12.50']]), 'Layer,Length (m)\r\nWALLS,12.50\r\n');
});

test('the CSV carries a byte-order mark so Excel reads accents', () => {
  assert.equal(UTF8_BOM, '\uFEFF');
});