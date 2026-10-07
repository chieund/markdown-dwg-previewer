import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDrawing } from '../src/webview/search';
import type { ObjectInfo } from '../src/shared/types';

const objects: ObjectInfo[] = [
  { type: 'TEXT', layer: 'Text', page: 0, text: 'LIVING ROOM' },
  { type: 'TEXT', layer: 'Text', page: 1, text: 'Living room (sheet)' },
  { type: 'MTEXT', layer: 'Text', page: 0, text: '居間 リビング' },
  {
    type: 'INSERT', layer: 'Doors', page: 0, block: 'DOOR-900',
    attributes: [{ tag: 'TAG', value: 'D-101' }, { tag: 'MAKER', value: 'ACME', hidden: true }],
  },
  { type: 'INSERT', layer: 'Doors', page: 0, block: 'DOOR-900' },
  { type: 'INSERT', layer: 'Furniture', page: 0, block: 'TABLE' },
  { type: 'LINE', layer: 'Walls', page: 0 },
  { type: 'LINE', layer: 'Walls', page: 0 },
];

const group = (query: string, kind: string) => searchDrawing(objects, query).find((g) => g.kind === kind);

test('text matches ignore case and list one hit per object, with its page', () => {
  const hits = group('living', 'text')?.hits ?? [];
  assert.deepEqual(hits.map((h) => [h.label, h.page, h.objects]), [
    ['LIVING ROOM', 0, [0]],
    ['Living room (sheet)', 1, [1]],
  ]);
});

test('Japanese text is found', () => {
  assert.deepEqual(group('リビング', 'text')?.hits.map((h) => h.objects), [[2]]);
});

test('attributes match on tag or value, hidden ones included', () => {
  assert.deepEqual(group('d-101', 'attribute')?.hits.map((h) => h.label), ['TAG = D-101']);
  assert.deepEqual(group('acme', 'attribute')?.hits.map((h) => h.label), ['MAKER = ACME (hidden)']);
});

test('a block name collects every insert of it on a page', () => {
  const hits = group('door', 'block')?.hits ?? [];
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'DOOR-900');
  assert.deepEqual(hits[0].objects, [3, 4]);
});

test('layer and entity type matches group their objects', () => {
  assert.deepEqual(group('wall', 'layer')?.hits.map((h) => [h.label, h.objects]), [['Walls', [6, 7]]]);
  assert.deepEqual(group('line', 'type')?.hits.map((h) => [h.label, h.objects]), [['LINE', [6, 7]]]);
});

test('groups report their full count but list at most the limit', () => {
  const many: ObjectInfo[] = Array.from({ length: 120 }, (_, i) => ({ type: 'TEXT', layer: '0', page: 0, text: `Room ${i}` }));
  const text = searchDrawing(many, 'room', 50).find((g) => g.kind === 'text');
  assert.equal(text?.total, 120);
  assert.equal(text?.hits.length, 50);
});

test('an empty query finds nothing, and empty groups are left out', () => {
  assert.deepEqual(searchDrawing(objects, '   '), []);
  assert.deepEqual(searchDrawing(objects, 'living').map((g) => g.kind), ['text']);
});

test('objects that draw nothing are not offered', () => {
  const hits = searchDrawing([{ type: 'LINE', layer: 'Walls', page: 0, empty: true }, { type: 'LINE', layer: 'Walls', page: 0 }], 'walls');
  assert.deepEqual(hits[0].hits[0].objects, [1]);
});
