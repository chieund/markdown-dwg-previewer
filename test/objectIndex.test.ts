import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectIndex } from '../src/webview/objectIndex';
import { inspectorRows } from '../src/webview/inspector';
import type { DxfEntity } from '../src/shared/types';

const line = (x1: number, y1: number, x2: number, y2: number, obj?: number): DxfEntity => ({
  type: 'LINE', layer: '0', color: '#fff', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, obj,
});

test('elements are found from their object and objects from their element', () => {
  const index = new ObjectIndex<object>();
  const a = {};
  const b = {};
  index.add(line(0, 0, 1, 1, 3), a);
  index.add(line(0, 0, 1, 1, 3), b);

  assert.deepEqual(index.elementsOf([3]), [a, b]);
  assert.equal(index.objectOf(b), 3);
  assert.equal(index.objectOf({}), undefined);
});

test('the bounds of a selection cover all of its objects', () => {
  const index = new ObjectIndex<object>();
  index.add(line(0, 0, 10, 5, 1), {});
  index.add(line(20, -5, 30, 0, 2), {});
  index.add(line(100, 100, 200, 200, 9), {});

  assert.deepEqual(index.boundsOf([1, 2]), { minX: 0, minY: -5, maxX: 30, maxY: 5 });
  assert.equal(index.boundsOf([42]), null);
});

test('entities without an object are drawn but not selectable', () => {
  const index = new ObjectIndex<object>();
  const el = {};
  index.add(line(0, 0, 1, 1), el);
  assert.equal(index.objectOf(el), undefined);
});

test('the inspector lists what is known about an insert, in reading order', () => {
  const rows = inspectorRows({
    type: 'INSERT', layer: 'Doors', handle: 'B1', page: 0, block: 'DOOR',
    position: { x: 1234.5678, y: -2 }, rotation: 90, scale: { x: 1, y: 1 },
  });
  assert.deepEqual(rows, [
    ['Type', 'INSERT'],
    ['Block', 'DOOR'],
    ['Layer', 'Doors'],
    ['Handle', 'B1'],
    ['Position', '1234.57, -2.00'],
    ['Rotation', '90°'],
    ['Scale', '1 × 1'],
  ]);
});

test('the inspector shows the text of a text object and skips what it lacks', () => {
  assert.deepEqual(inspectorRows({ type: 'TEXT', layer: 'Text', page: 0, text: 'LIVING ROOM' }), [
    ['Type', 'TEXT'],
    ['Layer', 'Text'],
    ['Text', 'LIVING ROOM'],
  ]);
});
