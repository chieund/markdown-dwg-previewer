import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffDrawings } from '../src/diff/diffDrawings';
import type { DxfEntity, DxfPage, ObjectInfo, ParsedDxf } from '../src/shared/types';

/** One drawn line per object, so geometry and objects stay easy to line up. */
interface Spec {
  handle?: string;
  type?: string;
  layer?: string;
  text?: string;
  line: [number, number, number, number];
  attributes?: ObjectInfo['attributes'];
}

const drawing = (pages: Record<string, Spec[]>): ParsedDxf => {
  const objects: ObjectInfo[] = [];
  const builtPages: DxfPage[] = Object.entries(pages).map(([name, specs], pageIndex) => {
    const entities: DxfEntity[] = specs.map((spec) => {
      const obj = objects.push({
        type: spec.type ?? 'LINE', layer: spec.layer ?? '0', page: pageIndex,
        handle: spec.handle, text: spec.text, attributes: spec.attributes,
      }) - 1;
      const [x1, y1, x2, y2] = spec.line;
      return { type: 'LINE', layer: spec.layer ?? '0', color: '#fff', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, obj };
    });
    return { name, entities, bounds: null, layers: [] };
  });
  return { pages: builtPages, objects, skippedEntityTypes: [] };
};

const counts = (page: { unchanged: unknown[]; added: unknown[]; removed: unknown[]; changedNew: unknown[] }) => ({
  unchanged: page.unchanged.length, added: page.added.length, removed: page.removed.length, changed: page.changedNew.length,
});

test('objects are matched by handle: unchanged, changed, added and removed', () => {
  const before = drawing({ Model: [
    { handle: 'A', line: [0, 0, 1, 0] },
    { handle: 'B', line: [0, 1, 1, 1] },
    { handle: 'C', line: [0, 2, 1, 2] },
  ] });
  const after = drawing({ Model: [
    { handle: 'A', line: [0, 0, 1, 0] },
    { handle: 'B', line: [5, 1, 6, 1] }, // moved
    { handle: 'D', line: [0, 3, 1, 3] }, // new
  ] });

  const diff = diffDrawings(before, after, 'old', 'new');
  assert.equal(diff.handleMatching, true);
  assert.deepEqual(counts(diff.pages[0]), { unchanged: 1, added: 1, removed: 1, changed: 1 });
  assert.equal(diff.pages[0].changedOld.length, 1, 'the old shape of a changed object is kept');
  assert.deepEqual(diff.pages[0].changes.map((c) => c.kind).sort(), ['added', 'changed', 'removed']);
});

test('float noise from re-saving is not a change', () => {
  const before = drawing({ Model: [{ handle: 'A', line: [0.1 + 0.2, 0, 1, 0] }] });
  const after = drawing({ Model: [{ handle: 'A', line: [0.3, 0, 1, 0] }] });
  assert.deepEqual(counts(diffDrawings(before, after, 'o', 'n').pages[0]), { unchanged: 1, added: 0, removed: 0, changed: 0 });
});

test('an edited attribute or text is a change even when the geometry is the same', () => {
  const before = drawing({ Model: [
    { handle: 'A', type: 'INSERT', line: [0, 0, 1, 0], attributes: [{ tag: 'TAG', value: 'D-101' }] },
    { handle: 'T', type: 'TEXT', text: 'LIVING ROOM', line: [0, 5, 1, 5] },
  ] });
  const after = drawing({ Model: [
    { handle: 'A', type: 'INSERT', line: [0, 0, 1, 0], attributes: [{ tag: 'TAG', value: 'D-102' }] },
    { handle: 'T', type: 'TEXT', text: 'LOUNGE', line: [0, 5, 1, 5] },
  ] });
  const page = diffDrawings(before, after, 'o', 'n').pages[0];
  assert.equal(page.changedNew.length, 2);
  assert.ok(page.changes.some((c) => c.label.includes('"LIVING ROOM" → "LOUNGE"')), JSON.stringify(page.changes));
});

test('renumbered handles fall back to matching by signature', () => {
  const before = drawing({ Model: [
    { handle: '1', line: [0, 0, 1, 0] },
    { handle: '2', line: [0, 1, 1, 1] },
    { handle: '3', line: [0, 2, 1, 2] },
  ] });
  const after = drawing({ Model: [
    { handle: '91', line: [0, 0, 1, 0] },
    { handle: '92', line: [0, 1, 1, 1] },
    { handle: '93', line: [9, 9, 10, 9] },
  ] });

  const diff = diffDrawings(before, after, 'o', 'n');
  assert.equal(diff.handleMatching, false);
  assert.deepEqual(counts(diff.pages[0]), { unchanged: 2, added: 1, removed: 1, changed: 0 });
});

test('drawings without handles are matched by signature, duplicates counted', () => {
  const before = drawing({ Model: [{ line: [0, 0, 1, 0] }, { line: [0, 0, 1, 0] }] });
  const after = drawing({ Model: [{ line: [0, 0, 1, 0] }] });
  assert.deepEqual(counts(diffDrawings(before, after, 'o', 'n').pages[0]), { unchanged: 1, added: 0, removed: 1, changed: 0 });
});

test('pages pair up by name; a page on one side only is wholly added or removed', () => {
  const before = drawing({ Model: [{ handle: 'A', line: [0, 0, 1, 0] }], 'Paper Space 2': [{ handle: 'P', line: [0, 0, 1, 0] }] });
  const after = drawing({ Model: [{ handle: 'A', line: [0, 0, 1, 0] }], 'Paper Space 3': [{ handle: 'Q', line: [0, 0, 1, 0] }] });

  const pages = diffDrawings(before, after, 'o', 'n').pages;
  assert.deepEqual(pages.map((p) => p.name), ['Model', 'Paper Space 3', 'Paper Space 2']);
  assert.deepEqual(counts(pages[1]), { unchanged: 0, added: 1, removed: 0, changed: 0 });
  assert.deepEqual(counts(pages[2]), { unchanged: 0, added: 0, removed: 1, changed: 0 });
});

test('each change knows where it is, covering both old and new shapes', () => {
  const before = drawing({ Model: [{ handle: 'B', line: [0, 0, 1, 0] }] });
  const after = drawing({ Model: [{ handle: 'B', line: [10, 5, 11, 5] }] });
  const [change] = diffDrawings(before, after, 'o', 'n').pages[0].changes;
  assert.deepEqual(change.bounds, { minX: 0, minY: 0, maxX: 11, maxY: 5 });
});

test('identical drawings have no changes', () => {
  const same = { Model: [{ handle: 'A', line: [0, 0, 1, 0] as [number, number, number, number] }] };
  const diff = diffDrawings(drawing(same), drawing(same), 'o', 'n');
  assert.equal(diff.pages[0].changes.length, 0);
});

// ── Review fixes ─────────────────────────────────────────────────────────

import { parseDxf } from '../src/dxf/parseDxf';

const r12 = (...lines: [number, number, number, number][]) =>
  ['0', 'SECTION', '2', 'ENTITIES',
    ...lines.flatMap(([x1, y1, x2, y2]) => ['0', 'LINE', '8', '0', '10', String(x1), '20', String(y1), '30', '0', '11', String(x2), '21', String(y2), '31', '0']),
    '0', 'ENDSEC', '0', 'EOF'].join('\n');

test('an R12 file (no handles) deleting its first line reports one removal, not a cascade', () => {
  const before = parseDxf(r12([0, 0, 1, 0], [0, 1, 1, 1], [0, 2, 1, 2], [0, 3, 1, 3]));
  const after = parseDxf(r12([0, 1, 1, 1], [0, 2, 1, 2], [0, 3, 1, 3]));
  assert.deepEqual(counts(diffDrawings(before, after, 'o', 'n').pages[0]), { unchanged: 3, added: 0, removed: 1, changed: 0 });
});

test('sequentially renumbered handles do not cascade into false changes', () => {
  const lines: [number, number, number, number][] = [[0, 0, 1, 0], [0, 1, 1, 1], [0, 2, 1, 2], [0, 3, 1, 3], [0, 4, 1, 4]];
  const before = drawing({ Model: lines.map((line, i) => ({ handle: String(i + 1), line })) });
  // The writer renumbered after #2 was deleted
  const after = drawing({ Model: lines.filter((_, i) => i !== 1).map((line, i) => ({ handle: String(i + 1), line })) });
  assert.deepEqual(counts(diffDrawings(before, after, 'o', 'n').pages[0]), { unchanged: 4, added: 0, removed: 1, changed: 0 });
});

test('float noise near zero is not a change', () => {
  const before = drawing({ Model: [{ handle: 'A', line: [0, 0, 1000, 0] }] });
  const after = drawing({ Model: [{ handle: 'A', line: [-1.42e-14, 0, 1000, 0] }] });
  assert.equal(diffDrawings(before, after, 'o', 'n').pages[0].changes.length, 0);
});

test('a 1 mm move at survey coordinates is a change', () => {
  const at = (y: number): [number, number, number, number] => [512000.5, y, 512010.5, y];
  const before = drawing({ Model: [{ handle: 'A', line: at(4500000.123) }, { handle: 'B', line: [511000, 4499000, 513000, 4501000] }] });
  const after = drawing({ Model: [{ handle: 'A', line: at(4500000.124) }, { handle: 'B', line: [511000, 4499000, 513000, 4501000] }] });
  assert.equal(diffDrawings(before, after, 'o', 'n').pages[0].changes.length, 1);
});

test('the order of the pieces inside an object does not matter', () => {
  const before = drawing({ Model: [{ handle: 'A', line: [0, 0, 1, 0] }] });
  const after = drawing({ Model: [{ handle: 'A', line: [0, 0, 1, 0] }] });
  // Same object drawn as two lines, listed in opposite orders
  const extra = (d: ParsedDxf, first: boolean) => {
    const a = d.pages[0].entities[0];
    const b: DxfEntity = { ...a, start: { x: 5, y: 5 }, end: { x: 6, y: 5 } } as DxfEntity;
    d.pages[0].entities = first ? [a, b] : [b, a];
  };
  extra(before, true);
  extra(after, false);
  assert.equal(diffDrawings(before, after, 'o', 'n').pages[0].changes.length, 0);
});

test('entities that belong to no object are still compared and drawn', () => {
  const before = drawing({ Model: [{ handle: 'A', line: [0, 0, 1, 0] }] });
  const after = drawing({ Model: [{ handle: 'A', line: [0, 0, 1, 0] }] });
  const orphan = (text: string): DxfEntity => ({ type: 'TEXT', layer: '0', color: '#fff', position: { x: 0, y: 0 }, text, height: 1, rotation: 0 });
  before.pages[0].entities.push(orphan('A1'));
  after.pages[0].entities.push(orphan('B2'));
  const page = diffDrawings(before, after, 'o', 'n').pages[0];
  assert.deepEqual(counts(page), { unchanged: 1, added: 1, removed: 1, changed: 0 });
});

test('warnings say which side they come from, once each', () => {
  const before = { ...drawing({ Model: [] }), warnings: ['Drawing cut short'] };
  const after = { ...drawing({ Model: [] }), warnings: ['Drawing cut short'] };
  assert.deepEqual(diffDrawings(before, after, 'a.dwg (HEAD)', 'a.dwg').warnings, ['a.dwg (HEAD): Drawing cut short', 'a.dwg: Drawing cut short']);
});
